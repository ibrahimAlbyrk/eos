//! Sync and file transfer in the composed app: what the features contribute
//! reaches the relay's vault sealed, and this computer's disk is served as a
//! transfer endpoint.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{App, Options};
use eos_domain::sync::{SyncKeys, parse_sync_key};
use eos_runtime::http::{Method, Request, Response};
use eos_testkit::vault::{FakeVault, VaultLimits};
use eos_testkit::{FakeClock, SeqIds, TempHome};
use serde_json::{Value, json};

fn options(home: &TempHome) -> Options {
    Options {
        clock: Arc::new(FakeClock::new()),
        ids: Arc::new(SeqIds::new()),
        env: Default::default(),
        ..Options::new(home.path())
    }
}

async fn json_of(res: Response) -> (u16, Value) {
    let status = res.status;
    let body = res.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn every_feature_that_contributes_data_syncs_it_to_the_vault() {
    let vault = FakeVault::new(VaultLimits::default());
    let served = vault.serve().await;
    let home = TempHome::new();
    // The relay hosting uses is the one a new sync account is created on.
    home.write("config.json", json!({ "peer": { "relayUrl": served.relay_url(), "name": "Test Mac" } }).to_string());
    home.write("templates/review.md", "---\ndescription: d\n---\n\nbody\n");
    home.write("workers/reviewer.md", "---\nname: reviewer\n---\nReview.\n");
    let app = App::build(options(&home)).expect("builds");
    app.start().await.expect("starts");
    let router = app.router();
    assert_eq!(router.undeclared(), Vec::<String>::new());
    let dashboard = app.callers().classify(Some(app.callers().ui_token()));
    let page_frame = app.callers().classify(None);

    let (status, off) = json_of(router.handle(Request::new(Method::Get, "/api/sync", page_frame.clone())).await).await;
    assert_eq!((status, &off["phase"]), (200, &json!("off")));
    let refused = router.handle(Request::new(Method::Post, "/api/sync/create", page_frame.clone())).await;
    assert_eq!(refused.status, 403, "starting sync is the user's");

    let page =
        Request::new(Method::Post, "/api/pages", page_frame.clone()).body(r##"{"title":"Plan","body":"# Plan\n"}"##);
    assert_eq!(router.handle(page).await.status, 201);
    let save = Request::new(Method::Put, "/api/profile", dashboard.clone())
        .body(r#"{"patch":{"identity":{"callName":"Sam"}},"baseRev":0}"#);
    assert_eq!(router.handle(save).await.status, 200);
    let remember = Request::new(Method::Post, "/api/user-memories", dashboard.clone())
        .body(r#"{"text":"When writing Go, use tabs.","category":"work-style","scope":{"kind":"global"}}"#);
    assert_eq!(router.handle(remember).await.status, 201);

    let (status, created) =
        json_of(router.handle(Request::new(Method::Post, "/api/sync/create", dashboard.clone())).await).await;
    assert_eq!(status, 200);
    // Every domain is there, in the order they are pushed.
    let domains: Vec<&String> = created["counts"].as_object().expect("counts").keys().collect();
    assert_eq!(domains, ["profile", "avatar", "memory", "template", "worker", "page"]);

    let (_, key) = json_of(router.handle(Request::new(Method::Get, "/api/sync/key", dashboard.clone())).await).await;
    let identity = parse_sync_key(key["key"].as_str().expect("a key")).expect("a sync key");
    let keys = SyncKeys::derive(&identity.secret);
    assert!(home.join("sync/identity.json").is_file());

    // The first pass pushes one record each: profile identity, memory, template, worker, page.
    let mut events = app.runtime().kernel.bus.subscribe("sync:change", 64);
    let pushed = async {
        while vault.records(&keys.vault_id).len() < 5 {
            let _ = events.recv().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(20), pushed).await.expect("the first pass");
    let mut seen: Vec<(String, String)> = vault
        .records(&keys.vault_id)
        .iter()
        .map(|record| {
            let plain = keys.open(&record.key, &record.data).expect("sealed with this account's key");
            let envelope: Value = serde_json::from_slice(&plain).expect("an envelope");
            assert_eq!(envelope["device"], "Test Mac");
            (
                envelope["domain"].as_str().unwrap_or_default().to_owned(),
                envelope["id"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    seen.sort();
    let domains: Vec<&str> = seen.iter().map(|(domain, _)| domain.as_str()).collect();
    assert_eq!(domains, ["memory", "page", "profile", "template", "worker"]);
    assert!(
        seen.contains(&("profile".into(), "identity".into())) && seen.contains(&("worker".into(), "reviewer".into()))
    );

    let (status, left) =
        json_of(router.handle(Request::new(Method::Post, "/api/sync/leave", dashboard.clone())).await).await;
    assert_eq!((status, &left["phase"]), (200, &json!("off")));
    assert!(!home.join("sync/identity.json").exists());
    app.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn this_computers_disk_is_a_transfer_endpoint_and_nothing_lands_in_its_data_folder() {
    let home = TempHome::new();
    let files = tempfile::tempdir().expect("a folder");
    let folder = std::fs::canonicalize(files.path()).expect("its real path");
    std::fs::write(folder.join("a.txt"), "abc").expect("a file");
    let app = App::build(options(&home)).expect("builds");
    app.start().await.expect("starts");
    let router = app.router();
    let dashboard = app.callers().classify(Some(app.callers().ui_token()));
    let page_frame = app.callers().classify(None);

    let list = format!("/transfer/list?path={}", folder.display());
    let (status, listing) = json_of(router.handle(Request::new(Method::Get, &list, dashboard.clone())).await).await;
    assert_eq!((status, &listing["entries"][0]["name"]), (200, &json!("a.txt")));
    let (status, refused) = json_of(router.handle(Request::new(Method::Get, &list, page_frame)).await).await;
    assert_eq!((status, refused), (403, json!({ "error": "ui token required", "code": "forbidden" })));

    let (_, manifest) = json_of(
        router
            .handle(
                Request::new(Method::Post, "/transfer/scan", dashboard.clone())
                    .body(json!({ "paths": [folder.join("a.txt")] }).to_string()),
            )
            .await,
    )
    .await;
    let into_data = json!({ "id": "tr-app00001", "destDir": home.join("pages"), "items": manifest["items"] });
    let (status, refused) = json_of(
        router
            .handle(Request::new(Method::Post, "/transfer/prepare", dashboard.clone()).body(into_data.to_string()))
            .await,
    )
    .await;
    assert_eq!((status, refused["code"].as_str()), (403, Some("forbidden-dest")));

    let (status, transfers) =
        json_of(router.handle(Request::new(Method::Get, "/api/transfers", dashboard.clone())).await).await;
    assert_eq!((status, transfers), (200, json!({ "transfers": [] })));
    // No computer is paired yet: a transfer to one is refused by name.
    let start = json!({ "from": "local", "to": "a".repeat(64), "paths": [folder.join("a.txt")] });
    let (status, refused) =
        json_of(router.handle(Request::new(Method::Post, "/api/transfers", dashboard).body(start.to_string())).await)
            .await;
    assert_eq!((status, refused), (400, json!({ "error": "that computer isn't paired with this Mac" })));
    app.shutdown(Duration::from_secs(5)).await;
}
