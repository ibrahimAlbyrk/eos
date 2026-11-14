//! Remote images and map resources for visual answers.
//!
//! The adapter owns the guard that keeps a URL an agent wrote away from the
//! local network, and the caches. Nothing here fails: an image that cannot be
//! had is `None` (the dashboard then draws a monogram), a map resource that
//! cannot be had is a [`MapResponse`] saying so.

use bytes::Bytes;

use crate::BoxFuture;

/// An image as it is served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaBlob {
    pub content_type: String,
    pub body: Bytes,
    /// Quoted, from the bytes: the same image always has the same tag.
    pub etag: String,
    pub fetched_at: i64,
}

pub trait MediaFetcher: Send + Sync + 'static {
    /// An image URL as written in a view.
    fn image<'a>(&'a self, src: &'a str) -> BoxFuture<'a, Option<MediaBlob>>;
    /// The preview image a page names (`og:image`, `twitter:image`).
    fn og<'a>(&'a self, page_url: &'a str) -> BoxFuture<'a, Option<MediaBlob>>;
    /// A site's icon by domain.
    fn icon<'a>(&'a self, site: &'a str) -> BoxFuture<'a, Option<MediaBlob>>;
}

/// What the map proxy answers with: the status and body are the proxy's own
/// (a JSON error for anything but 200).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapResponse {
    pub status: u16,
    /// Lower case, without parameters.
    pub content_type: String,
    pub body: Bytes,
    pub cache_control: &'static str,
}

/// The map behind visual answers: style, tiles, glyphs and sprites, fetched
/// only when asked for.
pub trait MapTiles: Send + Sync + 'static {
    /// The style document, every URL in it pointing back at the proxy.
    fn style(&self) -> BoxFuture<'_, MapResponse>;
    /// A path under the map provider's origin.
    fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, MapResponse>;
}
