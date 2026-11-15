//! What the bridge needs from the core: its router, and the ui-token it checks.
//!
//! `eos-runtime`'s `Router` is the real implementation (`router::RouterCore`, a thin
//! mapping from [`Req`] and [`Sink`] to its request and response types); a dev run puts the
//! guard in front of it (`dev::Guarded`, feature `dev-run`).

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::transport::{Req, Sink};

/// The core has two routers: the API, and raw content on its own origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plane {
    Api,
    Raw,
}

pub trait Core: Send + Sync + 'static {
    /// The token that proves a request comes from this Mac's dashboard.
    fn ui_token(&self) -> String;

    /// Routes one request. `req.url` is the origin-form target (`/path?query`). Must not
    /// block: answer through `sink` now or later, from any thread.
    fn call(&self, plane: Plane, req: Req, sink: Sink);

    /// Counters for diagnostics (no user data); shown in the shell's status.
    fn status(&self) -> serde_json::Value {
        serde_json::Value::Null
    }

    /// Returns once the core answers requests itself: at once, but for a core that is
    /// still starting ([`LateCore`]). Blocks: never on a request thread.
    fn wait_ready(&self) {}
}

/// Stands in while no core is built in: every route answers 503.
#[derive(Debug, Clone, Default)]
pub struct NoCore {
    pub ui_token: String,
}

impl Core for NoCore {
    fn ui_token(&self) -> String {
        self.ui_token.clone()
    }

    fn call(&self, _plane: Plane, _req: Req, sink: Sink) {
        sink.respond(503, vec![("content-type".into(), "application/json".into())], br#"{"error":"core_unavailable"}"#);
    }
}

/// How many requests a core that is still starting holds. Past that a request is answered
/// as [`NoCore`] answers it.
const HELD: usize = 4096;

enum Late {
    Starting(Vec<(Plane, Req, Sink)>),
    Ready(Arc<dyn Core>),
    Failed,
}

/// The core while it is built and started off the main thread, so the window and the
/// dashboard's page load do not wait for it. A request that arrives meanwhile is held and
/// handed over, in the order it came, once the core is up; when the core does not start,
/// every one is answered as [`NoCore`] answers. Its ui-token is known from the start.
pub struct LateCore {
    ui_token: String,
    state: Mutex<Late>,
    settled: Condvar,
}

impl std::fmt::Debug for LateCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LateCore").finish_non_exhaustive()
    }
}

impl LateCore {
    /// A core still starting, which will check `ui_token`.
    pub fn new(ui_token: String) -> Self {
        LateCore { ui_token, state: Mutex::new(Late::Starting(Vec::new())), settled: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Late> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits up to `timeout` for [`settle`](Self::settle); whether it came.
    pub fn wait_settled(&self, timeout: Duration) -> bool {
        let state = self.lock();
        let (state, _) = self
            .settled
            .wait_timeout_while(state, timeout, |state| matches!(*state, Late::Starting(_)))
            .unwrap_or_else(PoisonError::into_inner);
        !matches!(*state, Late::Starting(_))
    }

    /// The core is up (`Some`) or did not start (`None`): the held requests go to it, or
    /// are answered as [`NoCore`] answers. Only the first call counts.
    pub fn settle(&self, core: Option<Arc<dyn Core>>) {
        let mut state = self.lock();
        if !matches!(*state, Late::Starting(_)) {
            return;
        }
        let next = core.map_or(Late::Failed, Late::Ready);
        // Under the lock: a request that comes now waits for the held ones to be handed on.
        if let Late::Starting(held) = std::mem::replace(&mut *state, next) {
            for (plane, req, sink) in held {
                match &*state {
                    Late::Ready(core) => core.call(plane, req, sink),
                    _ => NoCore::default().call(plane, req, sink),
                }
            }
        }
        drop(state);
        self.settled.notify_all();
    }
}

impl Core for LateCore {
    fn ui_token(&self) -> String {
        match &*self.lock() {
            Late::Starting(_) => self.ui_token.clone(),
            Late::Ready(core) => core.ui_token(),
            Late::Failed => NoCore::default().ui_token(),
        }
    }

    fn call(&self, plane: Plane, req: Req, sink: Sink) {
        let mut state = self.lock();
        match &mut *state {
            Late::Starting(held) if held.len() < HELD => held.push((plane, req, sink)),
            Late::Starting(_) | Late::Failed => {
                drop(state);
                NoCore::default().call(plane, req, sink);
            }
            Late::Ready(core) => {
                let core = core.clone();
                drop(state);
                core.call(plane, req, sink);
            }
        }
    }

    fn status(&self) -> serde_json::Value {
        let core = match &*self.lock() {
            Late::Ready(core) => core.clone(),
            _ => return serde_json::Value::Null,
        };
        core.status()
    }

    fn wait_ready(&self) {
        let mut state = self.lock();
        while matches!(*state, Late::Starting(_)) {
            state = self.settled.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{Body, channel};

    /// Answers each request with 200, keeping what it was asked, in order.
    #[derive(Default)]
    struct Echo(Mutex<Vec<String>>);

    impl Core for Echo {
        fn ui_token(&self) -> String {
            "tok".into()
        }

        fn call(&self, _plane: Plane, req: Req, sink: Sink) {
            self.0.lock().unwrap().push(req.url.clone());
            sink.respond(200, vec![], req.url.as_bytes());
        }
    }

    fn ask(core: &dyn Core, url: &str) -> Body {
        let (sink, body) = channel();
        let req =
            Req { initiator: Default::default(), method: "GET".into(), url: url.into(), headers: vec![], body: vec![] };
        core.call(Plane::Api, req, sink);
        body
    }

    fn status(body: &Body) -> Option<u16> {
        body.head().map(|head| head.status)
    }

    #[test]
    fn requests_wait_for_the_core_and_reach_it_in_the_order_they_came() {
        let late = LateCore::new("tok".into());
        let early: Vec<Body> = (0..3).map(|i| ask(&late, &format!("/r{i}"))).collect();
        assert!(early.iter().all(|body| status(body).is_none()), "held while the core starts");
        assert_eq!(late.ui_token(), "tok");
        assert_eq!(late.status(), serde_json::Value::Null);

        let echo = Arc::new(Echo::default());
        late.settle(Some(echo.clone()));
        assert_eq!(*echo.0.lock().unwrap(), ["/r0", "/r1", "/r2"]);
        assert!(early.iter().all(|body| status(body) == Some(200)));
        assert_eq!(status(&ask(&late, "/after")), Some(200));
        assert_eq!(echo.0.lock().unwrap().last().map(String::as_str), Some("/after"));
        late.wait_ready();

        // Only the first settling counts.
        late.settle(None);
        assert_eq!(status(&ask(&late, "/still")), Some(200));
    }

    #[test]
    fn a_core_that_did_not_start_answers_as_no_core_does() {
        let late = LateCore::new("tok".into());
        let early = ask(&late, "/r");
        late.settle(None);
        let (no_core, from_no_core) = (NoCore::default(), ask(&NoCore::default(), "/r"));
        for body in [early, ask(&late, "/later")] {
            assert_eq!(body.head(), from_no_core.head());
            let mut buf = [0u8; 64];
            let n = body.read_now(&mut buf);
            assert_eq!(&buf[..n], br#"{"error":"core_unavailable"}"#);
        }
        assert_eq!(late.ui_token(), no_core.ui_token());
        late.wait_ready();
    }

    #[test]
    fn waiting_for_the_core_ends_when_it_settles() {
        let late = Arc::new(LateCore::new("tok".into()));
        let waiting = {
            let late = late.clone();
            std::thread::spawn(move || {
                late.wait_ready();
                late.ui_token()
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!waiting.is_finished());
        late.settle(Some(Arc::new(Echo::default())));
        assert_eq!(waiting.join().unwrap(), "tok");
    }

    #[test]
    fn a_bounded_wait_ends_without_the_core_or_when_it_settles() {
        let late = Arc::new(LateCore::new("tok".into()));
        assert!(!late.wait_settled(Duration::from_millis(20)), "still starting");
        let settling = {
            let late = late.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                late.settle(None);
            })
        };
        assert!(late.wait_settled(Duration::from_secs(10)));
        settling.join().unwrap();
        assert!(late.wait_settled(Duration::ZERO));
    }

    #[test]
    fn past_what_it_holds_a_request_is_answered_at_once() {
        let late = LateCore::new("tok".into());
        let held: Vec<Body> = (0..HELD).map(|_| ask(&late, "/r")).collect();
        assert_eq!(status(&ask(&late, "/one-too-many")), Some(503));
        let echo = Arc::new(Echo::default());
        late.settle(Some(echo.clone()));
        assert_eq!(echo.0.lock().unwrap().len(), HELD);
        assert!(held.iter().all(|body| status(body) == Some(200)));
    }
}
