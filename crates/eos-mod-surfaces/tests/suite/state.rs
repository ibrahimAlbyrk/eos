//! A surface's saved state, for the whole surface or one of its issues,
//! bounded by its level and announced after it is saved.

use eos_runtime::http::Method;
use eos_surface::{Level, Place};
use serde_json::json;

use crate::rig::{Rig, issue, surface};

#[tokio::test]
async fn state_is_saved_per_scope_and_announced() {
    let rig = Rig::new().await;
    rig.seed(
        vec![
            surface("sf-a", "rt-1", Level::View, Place::NeedsYou, 1),
            surface("sf-b", "rt-1", Level::View, Place::NeedsYou, 2),
        ],
        vec![],
        vec![issue("si-1", "sf-a"), issue("si-2", "sf-b")],
    )
    .await;

    let (status, body) = rig.ask(Method::Get, "/api/surfaces/sf-a/state", None).await;
    assert_eq!((status, body), (200, json!({"scope": "", "data": {}})));

    let (status, body) =
        rig.ask(Method::Put, "/api/surfaces/sf-a/state?scope=si-1", Some(json!({"data": {"note": "call back"}}))).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({"scope": "si-1", "data": {"note": "call back"}, "updatedAt": 5000}));
    let (_, body) = rig.ask(Method::Get, "/api/surfaces/sf-a/state?scope=si-1", None).await;
    assert_eq!(body["data"], json!({"note": "call back"}));
    assert_eq!(
        rig.ask(Method::Get, "/api/surfaces/sf-a/state", None).await.1["data"],
        json!({}),
        "the whole surface's is apart"
    );
    assert_eq!(rig.temp.announced.list(), [("surfaces:state", r#"{"surfaceId":"sf-a","scope":"si-1"}"#.to_owned())]);

    for (path, body, want) in [
        ("/api/surfaces/sf-a/state?scope=si-2", json!({"data": {}}), 404),
        ("/api/surfaces/sf-zz/state", json!({"data": {}}), 404),
        ("/api/surfaces/sf-a/state", json!({"data": [1]}), 400),
        ("/api/surfaces/sf-a/state", json!({"data": {"x": "y".repeat(33 * 1024)}}), 400),
    ] {
        assert_eq!(rig.ask(Method::Put, path, Some(body)).await.0, want, "{path}");
    }
    assert_eq!(rig.temp.announced.list().len(), 1, "a refused write announces nothing");
}

#[tokio::test]
async fn only_the_users_dashboard_writes_state() {
    let rig = Rig::new().await;
    rig.seed(vec![surface("sf-a", "rt-1", Level::View, Place::NeedsYou, 1)], vec![], vec![]).await;
    let page = eos_runtime::access::Caller::UNTRUSTED;
    let (status, _) = rig.ask_as(page, Method::Put, "/api/surfaces/sf-a/state", Some(json!({"data": {}}))).await;
    assert_eq!(status, 403);
}
