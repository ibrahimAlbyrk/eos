//! Images for visual answers, fetched by the app so the dashboard never talks
//! to arbitrary hosts and a URL an agent wrote never reaches the local
//! network (`infra/src/genui/GenuiMedia.ts`):
//!
//! - `image(src)`: an image URL → the image;
//! - `og(url)`: a page URL → its `og:image` / `twitter:image`;
//! - `icon(site)`: a domain → its apple-touch-icon / icon / favicon.
//!
//! Every fetch goes through the guarded GET, results (and failures, briefly)
//! are cached on disk, and concurrent asks for the same thing share one fetch.

use std::sync::{Arc, LazyLock};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use eos_core::net::{MediaBlob, MediaFetcher};
use eos_core::{BoxFuture, Clock};
use eos_kit_net::{SafeFetcher, SafeGetOptions, SafeResponse};
use regress::Regex;
use sha2::{Digest, Sha256};

use crate::cache::{Hit, Kind, MediaCache, Meta, cache_key};
use crate::html_meta::{extract_icons, extract_preview_image, normalize_site};
use crate::inflight::Inflight;

const IMAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
const PAGE_MAX_BYTES: usize = 1024 * 1024;
const ICON_TRIES: usize = 4;
/// Distinct images, pages and sites being fetched at once; a view holds 40
/// images at most. Beyond it an ask is answered "no image" without a fetch.
const MAX_IN_FLIGHT: usize = 256;

const IMAGE_ACCEPT: &str = "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8";
const HTML_ACCEPT: &str = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

/// Types a server sends for bytes that may still be an image; sniffed afterwards.
const OPAQUE_TYPES: [&str; 5] =
    ["", "application/octet-stream", "binary/octet-stream", "application/binary", "application/unknown"];

pub(crate) fn is_imageish(content_type: &str) -> bool {
    content_type.starts_with("image/") || OPAQUE_TYPES.contains(&content_type)
}

fn is_page(content_type: &str) -> bool {
    matches!(content_type, "" | "text/html" | "application/xhtml+xml")
}

static SVG_START: LazyLock<Regex> = LazyLock::new(|| {
    let pattern = r"^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]";
    Regex::with_flags(pattern, "i").unwrap_or_else(|e| panic!("pattern {pattern}: {e}"))
});

/// The image type from the first bytes, or `None` when they are not an image
/// Eos serves.
pub(crate) fn sniff_image_type(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" && matches!(&b[8..12], b"avif" | b"avis") {
        return Some("image/avif");
    }
    if b.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    if b.starts_with(b"BM") {
        return Some("image/bmp");
    }
    let head = String::from_utf8_lossy(&b[..b.len().min(1024)]);
    let head = eos_domain::text::js_trim_start(head.strip_prefix('\u{feff}').unwrap_or(&head));
    SVG_START.find(head).map(|_| "image/svg+xml")
}

/// The served type: a declared image type is kept (it goes out with
/// `nosniff`), anything opaque must sniff as an image.
pub(crate) fn image_type_of(declared: &str, body: &[u8]) -> Option<String> {
    if declared.starts_with("image/") {
        return Some(declared.to_owned());
    }
    sniff_image_type(body).map(str::to_owned)
}

pub(crate) fn etag_of(body: &[u8]) -> String {
    let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(body));
    format!("\"{}\"", &digest[..27])
}

/// The guarded GET, as this module uses it.
pub(crate) trait Fetch: Send + Sync + 'static {
    fn get<'a>(
        &'a self,
        url: &'a str,
        options: &'a SafeGetOptions,
    ) -> BoxFuture<'a, Result<SafeResponse, eos_kit_net::Error>>;
}

impl Fetch for SafeFetcher {
    fn get<'a>(
        &'a self,
        url: &'a str,
        options: &'a SafeGetOptions,
    ) -> BoxFuture<'a, Result<SafeResponse, eos_kit_net::Error>> {
        Box::pin(SafeFetcher::get(self, url, options))
    }
}

struct Inner {
    cache: Arc<MediaCache>,
    clock: Arc<dyn Clock>,
    fetcher: Arc<dyn Fetch>,
    user_agent: String,
    images: Inflight<Option<MediaBlob>>,
    /// Pages and sites being resolved to the image they name.
    refs: Inflight<Option<MediaBlob>>,
}

/// Cheap to clone; clones share the cache and what is in flight.
#[derive(Clone)]
pub struct GenuiMedia {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for GenuiMedia {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GenuiMedia").field("cache", &self.inner.cache).finish_non_exhaustive()
    }
}

impl GenuiMedia {
    pub(crate) fn new(
        cache: Arc<MediaCache>,
        clock: Arc<dyn Clock>,
        fetcher: Arc<dyn Fetch>,
        user_agent: String,
    ) -> Self {
        let (images, refs) = (Inflight::new(MAX_IN_FLIGHT), Inflight::new(MAX_IN_FLIGHT));
        Self { inner: Arc::new(Inner { cache, clock, fetcher, user_agent, images, refs }) }
    }

    async fn cached(&self, key: &str) -> Option<Hit> {
        let (cache, key) = (self.inner.cache.clone(), key.to_owned());
        tokio::task::spawn_blocking(move || cache.get(&key)).await.ok().flatten()
    }

    /// A full or read-only disk only costs a fetch next time.
    async fn store(&self, key: &str, meta: Meta, body: Option<Bytes>) {
        let (cache, key) = (self.inner.cache.clone(), key.to_owned());
        let stored = tokio::task::spawn_blocking(move || cache.put(&key, &meta, body.as_deref())).await;
        match stored {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "genui media: cache write failed"),
            Err(e) => tracing::warn!(error = %e, "genui media: cache write failed"),
        }
    }

    fn options(&self, max_bytes: usize, accept: &str, accept_type: fn(&str) -> bool) -> SafeGetOptions {
        let mut options = SafeGetOptions::new(self.inner.user_agent.clone(), max_bytes);
        options.accept = Some(accept.to_owned());
        options.accept_type = Some(accept_type);
        options
    }

    fn blob(content_type: String, body: Bytes, fetched_at: i64) -> MediaBlob {
        MediaBlob { etag: etag_of(&body), content_type, body, fetched_at }
    }

    async fn image_once(&self, src: String) -> Option<MediaBlob> {
        let key = cache_key("img", &src);
        let work = || {
            let (this, src, key) = (self.clone(), src.clone(), key.clone());
            async move { this.fetch_image(&key, &src).await }
        };
        self.inner.images.once(&key, work).await.flatten()
    }

    async fn fetch_image(&self, key: &str, src: &str) -> Option<MediaBlob> {
        match self.cached(key).await {
            Some(Hit { meta: Meta { kind: Kind::Blob, content_type, fetched_at, .. }, body: Some(body) }) => {
                return Some(Self::blob(content_type, body, fetched_at));
            }
            Some(Hit { meta: Meta { kind: Kind::Miss, .. }, .. }) => return None,
            _ => {}
        }
        let now = || self.inner.clock.now_ms();
        let options = self.options(IMAGE_MAX_BYTES, IMAGE_ACCEPT, is_imageish);
        let fetched = self.inner.fetcher.get(src, &options).await;
        let reason = match fetched {
            Ok(response) => match image_type_of(&response.content_type, &response.body) {
                Some(content_type) if !response.body.is_empty() => {
                    let fetched_at = now();
                    self.store(key, Meta::blob(src, &content_type, fetched_at), Some(response.body.clone())).await;
                    return Some(Self::blob(content_type, response.body, fetched_at));
                }
                _ => "the response is not an image".to_owned(),
            },
            Err(e) => e.to_string(),
        };
        tracing::debug!(url = src, error = %reason, "genui media: image fetch failed");
        self.store(key, Meta::miss(src, &reason, now()), None).await;
        None
    }

    async fn page(&self, url: &str) -> Option<(String, String)> {
        let options = self.options(PAGE_MAX_BYTES, HTML_ACCEPT, is_page);
        match self.inner.fetcher.get(url, &options).await {
            Ok(response) => Some((response.url, String::from_utf8_lossy(&response.body).into_owned())),
            Err(e) => {
                tracing::debug!(url, error = %e, "genui media: page fetch failed");
                None
            }
        }
    }

    /// A cached answer for a page or a site: the image its reference names,
    /// "nothing" for a remembered miss, or `Err` when it must be resolved.
    async fn resolved(&self, key: &str) -> Result<Option<MediaBlob>, ()> {
        match self.cached(key).await {
            Some(Hit { meta: Meta { kind: Kind::Ref, r#ref: Some(to), .. }, .. }) if !to.is_empty() => {
                Ok(self.image_once(to).await)
            }
            Some(Hit { meta: Meta { kind: Kind::Miss, .. }, .. }) => Ok(None),
            _ => Err(()),
        }
    }

    /// A page whose image is resolved once: the resolved URL is cached as a
    /// reference (the image under its own key); "nothing found" only as a
    /// short-lived miss, since a page that did not answer may answer later.
    async fn fetch_og(&self, key: &str, page_url: &str) -> Option<MediaBlob> {
        if let Ok(known) = self.resolved(key).await {
            return known;
        }
        let found = match self.page(page_url).await {
            Some((url, html)) => extract_preview_image(&html, &url),
            None => None,
        };
        let now = self.inner.clock.now_ms();
        let Some(image) = found else {
            self.store(key, Meta::miss(page_url, "no preview image", now), None).await;
            return None;
        };
        self.store(key, Meta::reference(page_url, &image, now), None).await;
        self.image_once(image).await
    }

    async fn fetch_icon(&self, key: &str, host: &str) -> Option<MediaBlob> {
        if let Ok(known) = self.resolved(key).await {
            return known;
        }
        let home = format!("https://{host}/");
        let www = (!host.starts_with("www.")).then(|| format!("https://www.{host}/"));
        let mut page = self.page(&home).await;
        if page.is_none()
            && let Some(www) = &www
        {
            page = self.page(www).await;
        }
        let candidates = match page {
            Some((url, html)) => extract_icons(&html, &url),
            // No page answered: the usual places at the root, with and without `www.`.
            None => std::iter::once(&home).chain(&www).flat_map(|root| extract_icons("", root)).collect(),
        };
        for url in candidates.into_iter().take(ICON_TRIES) {
            if let Some(image) = self.image_once(url.clone()).await {
                self.store(key, Meta::reference(host, &url, self.inner.clock.now_ms()), None).await;
                return Some(image);
            }
        }
        self.store(key, Meta::miss(host, "no icon", self.inner.clock.now_ms()), None).await;
        None
    }
}

impl MediaFetcher for GenuiMedia {
    fn image<'a>(&'a self, src: &'a str) -> BoxFuture<'a, Option<MediaBlob>> {
        Box::pin(self.image_once(src.to_owned()))
    }

    fn og<'a>(&'a self, page_url: &'a str) -> BoxFuture<'a, Option<MediaBlob>> {
        Box::pin(async move {
            let key = cache_key("og", page_url);
            let work = || {
                let (this, key, page_url) = (self.clone(), key.clone(), page_url.to_owned());
                async move { this.fetch_og(&key, &page_url).await }
            };
            self.inner.refs.once(&key, work).await.flatten()
        })
    }

    fn icon<'a>(&'a self, site: &'a str) -> BoxFuture<'a, Option<MediaBlob>> {
        Box::pin(async move {
            let host = normalize_site(site)?;
            let key = cache_key("icon", &host);
            let work = || {
                let (this, key, host) = (self.clone(), key.clone(), host.clone());
                async move { this.fetch_icon(&key, &host).await }
            };
            self.inner.refs.once(&key, work).await.flatten()
        })
    }
}

#[cfg(test)]
mod tests {
    //! `infra/src/__tests__/genui-media.test.ts`, with the guarded GET scripted.

    use std::collections::HashMap;
    use std::sync::Mutex;

    use eos_testkit::{FakeClock, TempHome};
    use reqwest::header::HeaderMap;

    use super::*;
    use crate::cache::Limits;

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

    /// (content type, body, the URL that answered when it differs).
    type Route = (&'static str, &'static [u8], Option<&'static str>);

    #[derive(Default)]
    struct Scripted {
        routes: HashMap<&'static str, Route>,
        calls: Mutex<Vec<String>>,
    }

    impl Fetch for Scripted {
        fn get<'a>(
            &'a self,
            url: &'a str,
            options: &'a SafeGetOptions,
        ) -> BoxFuture<'a, Result<SafeResponse, eos_kit_net::Error>> {
            Box::pin(async move {
                self.calls.lock().expect("calls").push(url.to_owned());
                let Some((content_type, body, answered)) = self.routes.get(url) else {
                    return Err(eos_kit_net::Error::Status(404));
                };
                if options.accept_type.is_some_and(|accepts| !accepts(content_type)) {
                    return Err(eos_kit_net::Error::Type((*content_type).to_owned()));
                }
                // Long enough for a second ask to arrive while this one is out.
                tokio::task::yield_now().await;
                Ok(SafeResponse {
                    url: answered.unwrap_or(url).to_owned(),
                    status: 200,
                    content_type: (*content_type).to_owned(),
                    headers: HeaderMap::new(),
                    body: Bytes::from_static(body),
                })
            })
        }
    }

    struct Made {
        media: GenuiMedia,
        fetch: Arc<Scripted>,
        _home: TempHome,
    }

    impl Made {
        fn calls(&self) -> Vec<String> {
            self.fetch.calls.lock().expect("calls").clone()
        }
    }

    fn make(routes: &[(&'static str, Route)]) -> Made {
        let home = TempHome::new();
        let clock = Arc::new(FakeClock::new());
        let fetch = Arc::new(Scripted { routes: routes.iter().copied().collect(), calls: Mutex::default() });
        let cache = Arc::new(MediaCache::new(home.path(), clock.clone(), Limits::default()));
        Made { media: GenuiMedia::new(cache, clock, fetch.clone(), "Eos/test".to_owned()), fetch, _home: home }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_asks_share_one_fetch_and_the_result_is_cached() {
        let m = make(&[("https://cdn.example/a.png", ("image/png", PNG, None))]);
        let (x, y) =
            tokio::join!(m.media.image("https://cdn.example/a.png"), m.media.image("https://cdn.example/a.png"));
        let (x, y) = (x.expect("an image"), y.expect("an image"));
        assert_eq!((x.content_type.as_str(), &x.body[..]), ("image/png", PNG));
        assert_eq!(x.etag, y.etag);
        assert_eq!(m.calls().len(), 1);
        assert!(m.media.image("https://cdn.example/a.png").await.is_some());
        assert_eq!(m.calls().len(), 1, "served from disk");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bytes_that_are_not_an_image_are_refused_and_the_miss_is_remembered() {
        let m = make(&[("https://cdn.example/fake.png", ("application/octet-stream", b"<html>", None))]);
        assert_eq!(m.media.image("https://cdn.example/fake.png").await, None);
        assert_eq!(m.media.image("https://cdn.example/fake.png").await, None);
        assert_eq!(m.calls().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_image_sent_as_octet_stream_is_sniffed() {
        let m = make(&[("https://cdn.example/b", ("application/octet-stream", PNG, None))]);
        assert_eq!(m.media.image("https://cdn.example/b").await.map(|i| i.content_type).as_deref(), Some("image/png"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_pages_preview_image_resolves_against_the_url_that_answered() {
        let html = br#"<html><head><meta property="og:image" content="/media/hero.jpg"><title>x</title></head><body></body></html>"#;
        let m = make(&[
            ("https://shop.example/item", ("text/html", html, Some("https://www.shop.example/item/1"))),
            ("https://www.shop.example/media/hero.jpg", ("image/jpeg", PNG, None)),
        ]);
        let image = m.media.og("https://shop.example/item").await.expect("the preview image");
        assert_eq!(image.content_type, "image/jpeg");
        assert!(m.media.og("https://shop.example/item").await.is_some());
        assert_eq!(m.calls(), ["https://shop.example/item", "https://www.shop.example/media/hero.jpg"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sites_best_icon_is_found_with_the_root_as_fallback() {
        let html = br#"<link rel="icon" href="/fav-16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180">"#;
        let m = make(&[
            ("https://acme.example/", ("text/html", html, None)),
            ("https://acme.example/touch.png", ("image/png", PNG, None)),
        ]);
        assert!(m.media.icon("https://Acme.example/about").await.is_some());
        assert_eq!(m.calls()[1], "https://acme.example/touch.png");
        // The resolved icon is remembered: the page is not read again.
        assert!(m.media.icon("acme.example").await.is_some());
        assert_eq!(m.calls().len(), 2);

        let bare = make(&[("https://www.plain.example/favicon.ico", ("image/x-icon", PNG, None))]);
        let icon = bare.media.icon("plain.example").await.expect("the favicon");
        assert_eq!(icon.content_type, "image/x-icon");
        assert_eq!(bare.calls()[..2], ["https://plain.example/", "https://www.plain.example/"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_site_that_is_not_a_domain_is_never_asked() {
        let m = make(&[]);
        assert_eq!(m.media.icon("localhost").await, None);
        assert_eq!(m.media.icon("10.0.0.1").await, None);
        assert!(m.calls().is_empty());
        // A site with no icon anywhere is remembered as a miss.
        assert_eq!(m.media.icon("empty.example").await, None);
        let asked = m.calls().len();
        assert_eq!(m.media.icon("empty.example").await, None);
        assert_eq!(m.calls().len(), asked);
    }
}
