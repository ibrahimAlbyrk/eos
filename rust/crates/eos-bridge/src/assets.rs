//! The dashboard bundle, served from a folder: the entry document with the bridge script and
//! the content security policy, and every other file as it is.

use std::path::{Path, PathBuf};

use crate::range::{self, Slice};
use crate::transport::Req;
use crate::urlspace::{RAW_BASE, percent_decode};

/// A response held whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Response { status, headers: vec![h("content-type", content_type)], body: body.into() }
    }

    pub fn not_found() -> Self {
        Response::new(404, "text/plain", "not found")
    }

    pub fn with(mut self, name: &str, value: &str) -> Self {
        self.headers.push(h(name, value));
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn h(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

pub fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The policy of the entry document: the app's own origin, plus the raw-content origin for
/// frames, images and media. `'unsafe-inline'` and `'wasm-unsafe-eval'` are what the
/// dashboard's theme bootstrap, its styles and pdf.js need; `img.logo.dev` is the one
/// outside host (its terms require loading logos from its CDN directly).
pub fn content_security_policy() -> String {
    [
        "default-src 'self'".to_string(),
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'".into(),
        "style-src 'self' 'unsafe-inline'".into(),
        format!("img-src 'self' data: blob: {RAW_BASE} https://img.logo.dev"),
        "font-src 'self' data:".into(),
        "connect-src 'self'".into(),
        format!("frame-src 'self' {RAW_BASE}"),
        "worker-src 'self' blob:".into(),
        format!("media-src 'self' data: blob: {RAW_BASE}"),
        "object-src 'none'".into(),
    ]
    .join("; ")
}

/// Puts `script` into the document as the first thing in `<head>`, so it runs before any
/// script of the dashboard.
pub fn inject_script(html: &str, script: &str) -> String {
    // A literal `</script` inside the script would end the element early.
    let tag = format!("<script>{}</script>", script.replace("</script", "<\\/script"));
    match html.find("<head>") {
        Some(i) => format!("{}{}{}", &html[..i + 6], tag, &html[i + 6..]),
        None => format!("{tag}{html}"),
    }
}

#[derive(Debug, Clone)]
pub struct Assets {
    root: PathBuf,
}

impl Assets {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Assets { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Serves `rel` (a path below the bundle root; `""` is the entry document).
    /// `entry_script` is injected into the entry document when given.
    pub fn serve(&self, rel: &str, req: &Req, entry_script: Option<&str>) -> Response {
        if !matches!(req.method.as_str(), "GET" | "HEAD") {
            return Response::new(405, "text/plain", "method not allowed");
        }
        let rel = percent_decode(rel);
        let rel = if rel.is_empty() { "index.html".to_string() } else { rel };
        let Some(full) = self.contained(&rel) else { return Response::not_found() };
        let Ok(bytes) = std::fs::read(&full) else { return Response::not_found() };
        if rel == "index.html" {
            let html = String::from_utf8_lossy(&bytes);
            let html = match entry_script {
                Some(script) => inject_script(&html, script),
                None => html.into_owned(),
            };
            return Response::new(200, mime(&rel), html)
                .with("content-security-policy", &content_security_policy())
                .with("cache-control", "no-store");
        }
        let len = bytes.len() as u64;
        let base = |status: u16, body: Vec<u8>| {
            Response::new(status, mime(&rel), body).with("accept-ranges", "bytes").with("cache-control", "no-cache")
        };
        match range::slice(req.header("range"), len) {
            Slice::Whole => base(200, bytes),
            Slice::Part { first, last } => base(206, bytes[first as usize..=last as usize].to_vec())
                .with("content-range", &range::content_range(first, last, len)),
            Slice::Unsatisfiable => base(416, Vec::new()).with("content-range", &format!("bytes */{len}")),
        }
    }

    /// The file for `rel`, only when it really lies in the bundle root (links resolved).
    fn contained(&self, rel: &str) -> Option<PathBuf> {
        let root = self.root.canonicalize().ok()?;
        let full = root.join(rel).canonicalize().ok()?;
        (full.starts_with(&root) && full.is_file()).then_some(full)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::Dir;

    fn bundle() -> (Dir, Assets) {
        let dir = Dir::new("assets");
        std::fs::create_dir_all(dir.path().join("dist/assets")).unwrap();
        std::fs::write(
            dir.path().join("dist/index.html"),
            "<!doctype html><html><head><title>Eos</title></head><body></body></html>",
        )
        .unwrap();
        std::fs::write(dir.path().join("dist/assets/app.js"), "0123456789").unwrap();
        std::fs::write(dir.path().join("dist/assets/a b.css"), "x{}").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "outside").unwrap();
        let assets = Assets::new(dir.path().join("dist"));
        (dir, assets)
    }

    fn get(headers: &[(&str, &str)]) -> Req {
        Req {
            initiator: Default::default(),
            method: "GET".into(),
            url: String::new(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: vec![],
        }
    }

    #[test]
    fn the_entry_document_gets_the_script_first_and_the_policy() {
        let (_dir, assets) = bundle();
        for rel in ["", "index.html"] {
            let r = assets.serve(rel, &get(&[]), Some("window.x = 1;"));
            assert_eq!(r.status, 200);
            let body = String::from_utf8(r.body.clone()).unwrap();
            assert!(body.contains("<head><script>window.x = 1;</script><title>"), "{body}");
            assert_eq!(r.header("content-security-policy"), Some(content_security_policy().as_str()));
            assert_eq!(r.header("cache-control"), Some("no-store"));
            assert_eq!(r.header("content-type"), Some("text/html; charset=utf-8"));
        }
    }

    #[test]
    fn without_a_script_the_entry_document_is_served_as_built() {
        let (_dir, assets) = bundle();
        let r = assets.serve("index.html", &get(&[]), None);
        assert!(!String::from_utf8(r.body).unwrap().contains("<script>"));
    }

    #[test]
    fn a_script_cannot_close_its_own_element() {
        let html = inject_script("<head></head>", "var s = '</script><b>';");
        assert_eq!(html, "<head><script>var s = '<\\/script><b>';</script></head>");
        assert_eq!(inject_script("<body>", "x"), "<script>x</script><body>");
    }

    #[test]
    fn files_with_type_and_range() {
        let (_dir, assets) = bundle();
        let whole = assets.serve("assets/app.js", &get(&[]), None);
        assert_eq!((whole.status, whole.body.as_slice()), (200, b"0123456789".as_slice()));
        assert_eq!(whole.header("content-type"), Some("text/javascript"));
        assert_eq!(whole.header("accept-ranges"), Some("bytes"));

        let part = assets.serve("assets/app.js", &get(&[("Range", "bytes=2-5")]), None);
        assert_eq!((part.status, part.body.as_slice()), (206, b"2345".as_slice()));
        assert_eq!(part.header("content-range"), Some("bytes 2-5/10"));

        let tail = assets.serve("assets/app.js", &get(&[("range", "bytes=7-")]), None);
        assert_eq!((tail.status, tail.body.as_slice()), (206, b"789".as_slice()));

        let past = assets.serve("assets/app.js", &get(&[("range", "bytes=10-")]), None);
        assert_eq!(past.status, 416);
        assert_eq!(past.header("content-range"), Some("bytes */10"));
    }

    #[test]
    fn encoded_names_are_decoded() {
        let (_dir, assets) = bundle();
        assert_eq!(assets.serve("assets/a%20b.css", &get(&[]), None).status, 200);
    }

    #[test]
    fn nothing_outside_the_bundle_is_served() {
        let (dir, assets) = bundle();
        for rel in
            ["../secret.txt", "assets/../../secret.txt", "%2e%2e/secret.txt", "/etc/hosts", "assets", "missing.js"]
        {
            assert_eq!(assets.serve(rel, &get(&[]), None).status, 404, "{rel}");
        }
        // A link that points out of the bundle is not followed.
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), dir.path().join("dist/link.txt")).unwrap();
        assert_eq!(assets.serve("link.txt", &get(&[]), None).status, 404);
    }

    #[test]
    fn only_reads() {
        let (_dir, assets) = bundle();
        let mut post = get(&[]);
        post.method = "POST".into();
        assert_eq!(assets.serve("index.html", &post, None).status, 405);
    }
}
