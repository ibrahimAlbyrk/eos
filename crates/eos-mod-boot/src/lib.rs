//! The boot snapshot (`GET /api/boot`): the reads the dashboard makes before it can draw
//! itself, in one answer that `index.html` asks for while the bundle loads.
//!
//! Each part is asked of its own route, through the router and as the snapshot's caller,
//! so it is that route's answer byte for byte and that route's access rule still holds.
//! The stream position is read first: a stream opened from it replays whatever changed
//! while the parts were read, so the dashboard misses nothing between its snapshot and
//! its stream.

use std::io::Write as _;
use std::sync::{Arc, OnceLock, Weak};

use eos_contracts::{BOOT_PARTS, boot_page_target};
use eos_runtime::access::{Access, Caller};
use eos_runtime::http::{ApiError, Body, Method, Request, Response};
use eos_runtime::module::Module;
use eos_runtime::router::{RouteDef, Router};
use eos_runtime::stream::StreamHub;
use futures_util::future::join_all;

/// The strictest rule of the parts: `/api/accounts` needs the user's dashboard, every
/// part crosses to a paired computer's dashboard, and the phone may call none of them
/// as a whole.
pub const ACCESS: Access = Access::ui_token();

/// A part larger than this is left out; the dashboard then asks its route itself. The
/// largest real one, a chat's newest page, is under 2 MB.
pub const PART_MAX_BYTES: usize = 8 * 1024 * 1024;

pub struct BootModule {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for BootModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BootModule").finish_non_exhaustive()
    }
}

struct Shared {
    stream: StreamHub,
    /// The app's router, handed over once it is built. Weak: the router holds this
    /// module's route.
    router: OnceLock<Weak<Router>>,
}

impl BootModule {
    pub fn new(stream: StreamHub) -> Self {
        Self { shared: Arc::new(Shared { stream, router: OnceLock::new() }) }
    }

    /// Hands over the app's router, once, after it was built: the parts are its routes.
    pub fn attach_router(&self, router: &Arc<Router>) {
        let _ = self.shared.router.set(Arc::downgrade(router));
    }
}

impl Module for BootModule {
    fn id(&self) -> &'static str {
        "boot"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let shared = self.shared.clone();
        vec![
            RouteDef::get("/api/boot", move |req: Request| {
                let shared = shared.clone();
                async move { shared.snapshot(req).await }
            })
            .access(ACCESS),
        ]
    }
}

impl Shared {
    async fn snapshot(&self, req: Request) -> Result<Response, ApiError> {
        let router = self
            .router
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| ApiError::status_with(503, "the app is still starting"))?;
        let hello = self.stream.hello();
        let mut targets: Vec<String> = BOOT_PARTS.iter().map(|t| (*t).to_owned()).collect();
        if let Some(worker) = req.query().get("focus").filter(|id| is_worker_id(id)) {
            targets.push(boot_page_target(&worker));
        }
        let answers = join_all(targets.iter().map(|target| part(&router, target, &req.caller))).await;
        Ok(Response::json_bytes(200, assemble(&hello, targets.iter().zip(answers)).into()))
    }
}

/// A chat's id as the dashboard keeps it; anything else could name another route.
fn is_worker_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What the route at `target` answers `caller`, when it is JSON of a size worth carrying.
async fn part(router: &Router, target: &str, caller: &Caller) -> Option<(u16, Vec<u8>)> {
    let res = router.handle(Request::new(Method::Get, target, caller.clone())).await;
    if !res.header_value("content-type").is_some_and(|t| t.starts_with("application/json")) {
        return None;
    }
    let status = res.status;
    let body = match res.body {
        Body::Empty => return None,
        Body::Bytes(bytes) => (bytes.len() <= PART_MAX_BYTES).then(|| bytes.to_vec())?,
        Body::Stream(mut stream) => {
            let mut out = Vec::new();
            while let Some(chunk) = stream.next().await {
                out.extend_from_slice(&chunk.ok()?);
                if out.len() > PART_MAX_BYTES {
                    return None;
                }
            }
            out
        }
    };
    Some((status, body))
}

/// `{"hello":…,"parts":{"<target>":{"status":…,"body":…},…}}`, bodies spliced in as written.
fn assemble<'a>(hello: &str, answers: impl Iterator<Item = (&'a String, Option<(u16, Vec<u8>)>)>) -> Vec<u8> {
    let answers: Vec<(&String, (u16, Vec<u8>))> = answers.filter_map(|(t, a)| Some((t, a?))).collect();
    let size: usize = answers.iter().map(|(t, (_, body))| t.len() + body.len() + 32).sum();
    let mut out = Vec::with_capacity(hello.len() + size + 32);
    out.extend_from_slice(b"{\"hello\":");
    out.extend_from_slice(hello.as_bytes());
    out.extend_from_slice(b",\"parts\":{");
    for (i, (target, (status, body))) in answers.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        // A target is plain ASCII, but it is written as a JSON string all the same.
        let key = serde_json::to_string(target).unwrap_or_else(|_| "\"\"".into());
        let _ = write!(out, "{key}:{{\"status\":{status},\"body\":");
        out.extend_from_slice(body);
        out.push(b'}');
    }
    out.extend_from_slice(b"}}");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_id_names_the_focused_chat() {
        for good in ["w-5et13g7r", "o-qs99vi", "w_1"] {
            assert!(is_worker_id(good), "{good}");
        }
        for bad in ["", "../api/accounts", "w-1?x=1", "w-1/events", "w 1", &"w".repeat(65)] {
            assert!(!is_worker_id(bad), "{bad}");
        }
    }

    #[test]
    fn bodies_are_spliced_in_as_written_and_missing_parts_left_out() {
        let (a, b, c) = ("/a".to_owned(), "/b\"".to_owned(), "/c".to_owned());
        let answers =
            vec![(&a, Some((200, b"[ 1 ]".to_vec()))), (&b, Some((404, br#"{"error":"x"}"#.to_vec()))), (&c, None)];
        let out = assemble(r#"{"seq":0}"#, answers.into_iter());
        assert_eq!(
            String::from_utf8(out).unwrap_or_default(),
            r#"{"hello":{"seq":0},"parts":{"/a":{"status":200,"body":[ 1 ]},"/b\"":{"status":404,"body":{"error":"x"}}}}"#
        );
    }
}
