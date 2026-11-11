//! What every route here shares: who may call, how a query becomes a request
//! type, and the path checks.

use std::path::{Path, PathBuf};

use eos_contracts::Validate;
use eos_kit_fs::path::is_safe_abs_path;
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{ApiError, Request, Response};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

pub(crate) type Handled = Result<Response, ApiError>;

/// A read the phone may make too.
pub(crate) const READ: Access = Access::open().phone(Tier::Read);
/// A read for dashboards only.
pub(crate) const DASHBOARD: Access = Access::open();
/// A change: the handler asks for the user's own dashboard after it has
/// checked the request, as today's handlers do (so a caller without it still
/// learns that its request was malformed). The phone reaches it at HIGH with
/// the gateway vouching for the user.
pub(crate) const CHANGE: Access = Access::open().phone_user(Tier::High);

/// A route's handler: `run` with the module's parts.
pub(crate) fn handler<F, Fut>(deps: &crate::Deps, run: F) -> impl Fn(Request) -> Fut + Send + Sync + 'static
where
    F: Fn(crate::Deps, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Handled> + Send + 'static,
{
    let deps = deps.clone();
    move |req| run(deps.clone(), req)
}

/// 400 with `message` as the whole error.
pub(crate) fn bad(message: &str) -> ApiError {
    ApiError::Validation(message.to_owned())
}

/// Only the user's own dashboard goes further.
pub(crate) fn require_user(req: &Request) -> Result<(), ApiError> {
    if req.speaks_for_user() { Ok(()) } else { Err(ApiError::PermissionDenied("ui token required".into())) }
}

/// An absolute path with no NUL byte, or 400 with `message`.
pub(crate) fn abs_path(path: Option<&str>, message: &str) -> Result<PathBuf, ApiError> {
    path.filter(|p| is_safe_abs_path(p)).map(PathBuf::from).ok_or_else(|| bad(message))
}

/// The gate of every change to a repository or a folder: the path is
/// absolute, then the caller is the user.
pub(crate) fn guard_mutation(req: &Request, cwd: &str) -> Result<PathBuf, ApiError> {
    let cwd = abs_path(Some(cwd), "cwd must be absolute")?;
    require_user(req)?;
    Ok(cwd)
}

/// The named query parameters as the request type `T`, checked against its
/// rules; a parameter that is absent is absent from the object.
pub(crate) fn query<T: DeserializeOwned + Validate>(req: &Request, names: &[&str]) -> Result<T, ApiError> {
    let mut object = Map::new();
    for name in names {
        if let Some(value) = req.query().get(name) {
            object.insert((*name).to_owned(), Value::String(value.into_owned()));
        }
    }
    Ok(eos_contracts::parse(&Value::Object(object))?)
}

pub(crate) fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// JavaScript's `encodeURIComponent`.
pub(crate) fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The lower-cased extension after the last dot of `path` (the whole text
/// when it has no dot, as `path.split(".").pop()` gives).
pub(crate) fn extension(path: &str) -> String {
    path.rsplit('.').next().unwrap_or_default().to_lowercase()
}

/// Content types of the images the panels show inline (`/fs/image`, `/fs/blob`).
pub(crate) fn image_mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Content types of what the raw-content origin serves.
pub(crate) fn content_type_for(path: &str) -> &'static str {
    match extension(path).as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        other => image_mime(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_and_types_follow_the_last_dot() {
        assert_eq!(extension("/a/b/Photo.PNG"), "png");
        assert_eq!(extension("/a/archive.tar.gz"), "gz");
        assert_eq!(extension("Makefile"), "makefile");
        assert_eq!(image_mime("svg"), "image/svg+xml");
        assert_eq!(image_mime("md"), "application/octet-stream");
        assert_eq!(content_type_for("/x/notes.md"), "text/plain; charset=utf-8");
        assert_eq!(content_type_for("/x/viewer.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("/x/icon.svg"), "image/svg+xml");
        assert_eq!(content_type_for("/x/unknown.bin"), "application/octet-stream");
    }

    #[test]
    fn uri_components_are_escaped_as_javascript_does() {
        assert_eq!(encode_uri_component("com.apple.TextEdit"), "com.apple.TextEdit");
        assert_eq!(encode_uri_component("a b/ç&=?"), "a%20b%2F%C3%A7%26%3D%3F");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    }

    #[test]
    fn only_absolute_paths_without_nul_pass() {
        assert_eq!(abs_path(Some("/a/b"), "m").ok(), Some(PathBuf::from("/a/b")));
        for refused in [None, Some("relative"), Some(""), Some("/a\0b")] {
            assert_eq!(abs_path(refused, "absolute path required"), Err(bad("absolute path required")));
        }
    }
}
