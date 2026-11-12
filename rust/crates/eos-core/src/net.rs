//! Ports over other computers: the sync vault, the update feed, transfer
//! endpoints, the Artifact catalog, media fetching, geocoding, the relay
//! (`core/src/ports/SyncVault.ts`, `Updates.ts`, `TransferEndpoint.ts`, …).

mod geo;
pub mod machines;
mod media;
pub mod relay;
pub mod sync;
pub mod transfer;
pub mod updates;

pub use geo::{GeoError, Geocoder, PlaceQuery, PlaceSearch};
pub use media::{MapResponse, MapTiles, MediaBlob, MediaFetcher};
