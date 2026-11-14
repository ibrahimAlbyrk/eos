//! What visual answers fetch from other computers (`infra/src/genui`):
//!
//! - [`GenuiMedia`]: images, a page's preview image, a site's icon — through
//!   the guarded GET of `eos-kit-net`, cached on disk;
//! - [`OpenFreeMapProxy`]: the map's style, tiles, glyphs and sprites, on demand;
//! - [`NominatimGeocoder`]: place names ⇄ coordinates, one request a second;
//! - [`OverpassPlaceSearch`]: places near a point.
//!
//! Everything caches under one folder (`<data folder>/media-cache`): images
//! and resolved references at the top level, geocoder and place answers under
//! `geo/`. The folder is regenerable; its formats are today's, so a cache the
//! previous app filled keeps answering.
//!
//! `rust/fixtures/genui-media/vectors.json` holds what the TypeScript computed
//! for the pure parts (`tests/vectors.rs`), frozen.

mod cache;
mod geo;
mod html_meta;
mod inflight;
mod map;
mod media;
mod num;
#[cfg(test)]
mod vectors;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use eos_core::{BoxFuture, Clock};
use eos_kit_net::{ClientOptions, SafeFetcher, http_client};

pub use geo::nominatim::{NOMINATIM_URL, NominatimGeocoder};
pub use geo::overpass::{OVERPASS_URL, OverpassPlaceSearch};
pub use map::{OPENFREEMAP_ORIGIN, OpenFreeMapProxy};
pub use media::GenuiMedia;

use cache::{Limits, MediaCache};
use geo::ttl_store::JsonTtlStore;

/// The folder under the data folder that holds every cache of this crate.
pub const MEDIA_CACHE_DIR: &str = "media-cache";

const GEOCODE_ENTRIES: usize = 2000;
const PLACE_ENTRIES: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// An HTTP client could not be set up.
    #[error("{0}")]
    Client(String),
}

/// How Eos names itself to the services it asks (OpenStreetMap's usage policy
/// wants an identifying User-Agent).
pub fn user_agent() -> String {
    "Eos/1 (+local desktop app)".to_owned()
}

/// Where the services are. The defaults are the real ones; a test points
/// them at a local server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub map_origin: String,
    pub nominatim: String,
    pub overpass: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            map_origin: OPENFREEMAP_ORIGIN.to_owned(),
            nominatim: NOMINATIM_URL.to_owned(),
            overpass: OVERPASS_URL.to_owned(),
        }
    }
}

/// How the pause between two geocoder requests is taken.
pub type Sleep = Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>;

pub struct Options {
    pub endpoints: Endpoints,
    /// The guarded GET for URLs an agent wrote.
    pub fetcher: SafeFetcher,
    pub sleep: Sleep,
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options").field("endpoints", &self.endpoints).finish_non_exhaustive()
    }
}

impl Options {
    /// The real services, the real address rules, real pauses.
    pub fn new() -> Result<Self, Error> {
        Ok(Self {
            endpoints: Endpoints::default(),
            fetcher: SafeFetcher::new().map_err(|e| Error::Client(e.to_string()))?,
            sleep: Arc::new(|pause| Box::pin(tokio::time::sleep(pause))),
        })
    }
}

/// The adapters, ready to hand to the feature as its ports.
#[derive(Debug, Clone)]
pub struct Services {
    pub media: Arc<GenuiMedia>,
    pub map: Arc<OpenFreeMapProxy>,
    pub geocoder: Arc<NominatimGeocoder>,
    pub places: Arc<OverpassPlaceSearch>,
}

/// Builds the adapters over the cache folder `dir`. Nothing is read or
/// fetched until the first ask.
pub fn build(dir: &Path, clock: Arc<dyn Clock>, options: Options) -> Result<Services, Error> {
    let agent = user_agent();
    let client = |follow_redirects| {
        let options = ClientOptions { follow_redirects, ..ClientOptions::new(agent.clone()) };
        http_client(&options).map_err(|e| Error::Client(e.to_string()))
    };
    let api = client(true)?;
    let cache = Arc::new(MediaCache::new(dir, clock.clone(), Limits::default()));
    let store = |file: &str, max| JsonTtlStore::new(dir.join("geo").join(file), clock.clone(), max);
    Ok(Services {
        media: Arc::new(GenuiMedia::new(cache, clock.clone(), Arc::new(options.fetcher), agent.clone())),
        // Every hop of a map request is checked against the map's origin.
        map: Arc::new(OpenFreeMapProxy::new(
            client(false)?,
            clock.clone(),
            &options.endpoints.map_origin,
            agent.clone(),
        )),
        geocoder: Arc::new(NominatimGeocoder::new(
            api.clone(),
            clock.clone(),
            options.sleep,
            store("nominatim.json", GEOCODE_ENTRIES),
            agent.clone(),
            &options.endpoints.nominatim,
        )),
        places: Arc::new(OverpassPlaceSearch::new(
            api,
            store("overpass.json", PLACE_ENTRIES),
            agent,
            &options.endpoints.overpass,
        )),
    })
}
