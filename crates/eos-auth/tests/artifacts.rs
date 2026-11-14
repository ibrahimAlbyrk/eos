//! The frame API adapter against a local server.

#![allow(clippy::unwrap_used)]

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use eos_auth::{FrameApiArtifacts, NO_TOKEN_MESSAGE, REJECTED_MESSAGE};
use eos_core::BoxFuture;
use eos_core::accounts::PlanAccess;
use eos_core::net::ArtifactSource;
use eos_domain::accounts::PlanLoginRecord;
use support::FakeServer;

const SLUG: &str = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

fn frames() -> String {
    format!(r#"{{"frames":[{{"slug":"{SLUG}","title":"Quarterly plan","updatedAt":"2026-10-29T10:00:00.000Z"}}]}}"#)
}

/// A sign-in whose token is `tokens[n]` after `n` renewals.
struct Access {
    tokens: Vec<Option<&'static str>>,
    renewals: Mutex<Vec<(String, String)>>,
    renews: bool,
}

impl Access {
    fn new(tokens: &[Option<&'static str>], renews: bool) -> Arc<Self> {
        Arc::new(Self { tokens: tokens.to_vec(), renewals: Mutex::default(), renews })
    }

    fn renewals(&self) -> Vec<(String, String)> {
        self.renewals.lock().unwrap().clone()
    }
}

impl PlanAccess for Access {
    fn logins(&self, _provider: &str) -> Vec<PlanLoginRecord> {
        Vec::new()
    }

    fn access_token<'a>(&'a self, _provider: &'a str, _login_id: &'a str) -> BoxFuture<'a, Option<String>> {
        let n = self.renewals.lock().unwrap().len().min(self.tokens.len() - 1);
        let token = self.tokens[n].map(str::to_owned);
        Box::pin(async move { token })
    }

    fn token_refused<'a>(&'a self, _provider: &'a str, login_id: &'a str, rejected: &'a str) -> BoxFuture<'a, bool> {
        self.renewals.lock().unwrap().push((login_id.to_owned(), rejected.to_owned()));
        let renews = self.renews;
        Box::pin(async move { renews })
    }

    fn login_of_worker(&self, _provider: &str, _worker_id: &str) -> Option<String> {
        None
    }

    fn utilization<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Option<f64>> {
        Box::pin(async { None })
    }
}

#[tokio::test]
async fn sends_the_sign_ins_token_with_the_frame_headers_and_nothing_that_poses_as_the_cli() {
    let server = FakeServer::start(|_| (200, frames())).await;
    let source = FrameApiArtifacts::at(&format!("{}/", server.url), Access::new(&[Some("tok-1")], false));
    let rows = source.list("lg-1").await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].login_id, "lg-1");
    let hits = server.hits();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].target, "/api/frame/frames?limit=200");
    let header = |name: &str| hits[0].headers.get(name).cloned().unwrap_or_default();
    assert_eq!(header("authorization"), "Bearer tok-1");
    assert_eq!(header("anthropic-beta"), "oauth-2025-04-20");
    assert_eq!(header("accept"), "application/json");
    assert_eq!(header("x-frame-surface"), "code");
    assert_eq!(header("x-frame-cp"), "go");
    assert!(header("user-agent").starts_with("eos/"), "{}", header("user-agent"));
}

#[tokio::test]
async fn a_rejected_token_is_renewed_once_read_again_and_retried_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    let server = FakeServer::start(move |_| match n.fetch_add(1, Ordering::SeqCst) {
        0 => (401, r#"{"error":"expired"}"#.into()),
        _ => (200, frames()),
    })
    .await;
    let access = Access::new(&[Some("old"), Some("new")], true);
    let source = FrameApiArtifacts::at(&server.url, access.clone());
    assert_eq!(source.list("lg-1").await.unwrap().len(), 1);
    assert_eq!(access.renewals(), [("lg-1".to_owned(), "old".to_owned())]);
    let tokens: Vec<_> = server.hits().iter().map(|h| h.headers["authorization"].clone()).collect();
    assert_eq!(tokens, ["Bearer old", "Bearer new"]);
}

#[tokio::test]
async fn a_second_rejection_an_unchanged_token_or_a_failed_renewal_says_to_sign_in_again() {
    let twice = FakeServer::start(|_| (401, "{}".into())).await;
    let source = FrameApiArtifacts::at(&twice.url, Access::new(&[Some("t0"), Some("t1")], true));
    assert_eq!(source.list("lg-1").await.unwrap_err(), REJECTED_MESSAGE);
    assert_eq!(twice.hits().len(), 2, "retried only once");

    let same = FakeServer::start(|_| (401, "{}".into())).await;
    let access = Access::new(&[Some("t"), Some("t")], true);
    let unchanged = FrameApiArtifacts::at(&same.url, access.clone());
    assert_eq!(unchanged.list("lg-1").await.unwrap_err(), REJECTED_MESSAGE);
    assert_eq!(access.renewals().len(), 1);
    assert_eq!(same.hits().len(), 1, "no retry with the token just refused");

    let failing = FakeServer::start(|_| (401, "{}".into())).await;
    let source = FrameApiArtifacts::at(&failing.url, Access::new(&[Some("t")], false));
    assert_eq!(source.list("lg-1").await.unwrap_err(), REJECTED_MESSAGE);
    assert_eq!(failing.hits().len(), 1);
}

#[tokio::test]
async fn no_token_is_an_error_saying_to_sign_in_again_without_a_request() {
    let server = FakeServer::start(|_| (200, frames())).await;
    let source = FrameApiArtifacts::at(&server.url, Access::new(&[None], false));
    assert_eq!(source.list("lg-1").await.unwrap_err(), NO_TOKEN_MESSAGE);
    assert!(server.hits().is_empty());
    assert!(NO_TOKEN_MESSAGE.contains("sign in again"));
}

#[tokio::test]
async fn other_failures_are_short_errors_naming_the_status_and_the_token_never_shows() {
    let answer = |status: u16, body: &'static str| async move {
        let server = FakeServer::start(move |_| (status, body.into())).await;
        FrameApiArtifacts::at(&server.url, Access::new(&[Some("secret-token")], false)).list("lg-1").await.unwrap_err()
    };
    assert_eq!(answer(404, r#"{"error":"nope"}"#).await, "Couldn't read artifacts (HTTP 404).");
    assert!(answer(429, r#"{"error":"slow down"}"#).await.contains("HTTP 429"));
    assert!(answer(200, "").await.contains("can't read"));
    assert!(answer(200, r#"{"items":[]}"#).await.contains("can't read"));

    // Nothing listens on a port the test just let go of.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let down = FrameApiArtifacts::at(&format!("http://127.0.0.1:{port}"), Access::new(&[Some("secret-token")], false));
    let error = down.list("lg-1").await.unwrap_err();
    assert!(error.starts_with("Couldn't reach the artifacts API: "), "{error}");
    assert!(!error.contains("secret-token") && !error.contains("127.0.0.1"), "{error}");
}
