//! `GET /v1/models` against a local server, with the token of the sign-in a
//! new session would use (`manager/services/ModelCatalogService.ts`).

#![allow(clippy::unwrap_used)]

mod support;

use std::path::PathBuf;
use std::sync::Arc;

use eos_auth::ClaudeModels;
use eos_core::accounts::SessionCredential;
use eos_core::agent::ModelsApi;
use eos_testkit::{FakeCredentials, FakePlanStores};
use support::FakeServer;

const LIST: &str = r#"{"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5","created_at":"2026-05-01T00:00:00Z","max_input_tokens":1000000,"max_tokens":128000}],"has_more":false}"#;

fn signed_in(store: Option<&str>) -> (Arc<FakeCredentials>, Arc<FakePlanStores>) {
    let (credentials, stores) = (Arc::new(FakeCredentials::default()), Arc::new(FakePlanStores::default()));
    if let Some(dir) = store {
        stores.sign_in(dir, Some("max"), None);
        let credential = SessionCredential::Store { provider: "anthropic".into(), dir: PathBuf::from(dir) };
        *credentials.new_session.lock().unwrap() = Some(credential);
    }
    (credentials, stores)
}

#[tokio::test]
async fn asks_with_the_new_sessions_sign_in_and_nothing_without_one() {
    let server = FakeServer::start(|_| (200, LIST.to_owned())).await;
    let (credentials, stores) = signed_in(Some("/acc/claude"));
    let models = ClaudeModels::at(&format!("{}/", server.url), credentials, stores);
    let listed = models.list().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].id.as_str(), listed[0].max_input_tokens), ("claude-opus-5-5", Some(1_000_000)));
    let hits = server.hits();
    assert_eq!(hits.len(), 1);
    assert_eq!((hits[0].method.as_str(), hits[0].target.as_str()), ("GET", "/v1/models?limit=100"));
    assert_eq!(hits[0].headers.get("authorization").unwrap(), "Bearer token-of:/acc/claude");
    assert_eq!(hits[0].headers.get("anthropic-version").unwrap(), "2023-06-01");
    assert!(!hits[0].headers.get("user-agent").unwrap().contains("claude"), "Eos names itself");

    let (credentials, stores) = signed_in(None);
    let nobody = ClaudeModels::at(&server.url, credentials, stores);
    assert_eq!(nobody.list().await, Err("no usable Claude OAuth token".to_owned()));
    assert_eq!(server.hits().len(), 1, "nothing is sent without a sign-in");
}

#[tokio::test]
async fn a_refusal_or_an_answer_it_cannot_read_is_an_error() {
    let server = FakeServer::start(|_| (401, r#"{"type":"error"}"#.to_owned())).await;
    let (credentials, stores) = signed_in(Some("/acc/claude"));
    let refused = ClaudeModels::at(&server.url, credentials.clone(), stores.clone());
    assert_eq!(refused.list().await, Err("models fetch failed: 401".to_owned()));

    let server = FakeServer::start(|_| (200, r#"{"models":[]}"#.to_owned())).await;
    let odd = ClaudeModels::at(&server.url, credentials, stores);
    assert_eq!(odd.list().await, Err("models fetch: unexpected response shape".to_owned()));
}
