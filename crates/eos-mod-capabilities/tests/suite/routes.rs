//! The routes: the list and one capability, switching it off and on, its
//! settings, a check, rollback and removal, candidates, and who may call
//! what.

use std::sync::Arc;

use eos_core::capability::{ActionCall, ActionCaller, ActionError, CapabilityCalls};
use eos_domain::capability::health::Event;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_testkit::FakeBuiltin;
use serde_json::json;

use crate::rig::{GITHUB, MAIL, SECRET, notes, rig};

fn github() -> Arc<FakeBuiltin> {
    Arc::new(FakeBuiltin::new(GITHUB))
}

fn agent(capability: &str, action: &str) -> ActionCall {
    ActionCall {
        capability: capability.into(),
        action: action.into(),
        input: json!({}),
        caller: ActionCaller::Agent { worker_id: "w-1".into() },
        idempotency_key: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_list_and_one_capability_show_secrets_as_set_or_not_and_never_their_values() {
    let signed_out = rig(vec![github(), Arc::new(FakeBuiltin::new(MAIL))], false).await;
    let (status, list) = signed_out.ask(Method::Get, "/api/capabilities", None).await;
    assert_eq!(status, 200);
    let row = list.as_array().expect("rows").iter().find(|row| row["id"] == "github").expect("github's row").clone();
    assert_eq!(
        row,
        json!({"id": "github", "name": "GitHub", "summary": "Pull requests and reviews on GitHub.", "origin": "builtin",
            "state": "needs_setup", "stateCode": "secret_missing:token", "works": "any_mac", "actionCount": 4, "usedBy": [], "form": "builtin"})
    );

    let (status, detail) = signed_out.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(status, 200);
    assert_eq!(detail["secrets"], json!([{"name": "token", "label": "GitHub sign-in", "set": false}]));
    assert_eq!(
        detail["actions"][2],
        json!({"name": "post_review", "summary": "Post a review.", "class": "speak", "undo": "withdraw_review"})
    );
    assert_eq!(detail["reach"], json!({"hosts": [], "apps": [], "files": []}));
    assert_eq!((detail["versions"].clone(), detail["recentCalls"].clone()), (json!([]), json!([])));

    let signed_in = rig(vec![github()], true).await;
    let (_, detail) = signed_in.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(detail["secrets"][0]["set"], true);
    assert!(!detail.to_string().contains(SECRET));
    assert_eq!(signed_out.ask(Method::Get, "/api/capabilities/nope", None).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn switching_off_and_on_is_announced() {
    let rig = rig(vec![github()], true).await;
    let (status, row) = rig.ask(Method::Post, "/api/capabilities/github/disable", Some("{}")).await;
    assert_eq!((status, row["state"].as_str()), (200, Some("disabled")));
    let (status, row) = rig.ask(Method::Post, "/api/capabilities/github/enable", Some("{}")).await;
    assert_eq!((status, row["state"].as_str()), (200, Some("ready")));
    assert_eq!(
        rig.changes(),
        [
            r#"{"id":"github","state":"ready"}"#,
            r#"{"id":"github","state":"disabled"}"#,
            r#"{"id":"github","state":"ready"}"#,
        ]
    );
    // Switched off, its calls are refused.
    rig.ask(Method::Post, "/api/capabilities/github/disable", None).await;
    let call = rig.service.call(agent("github", "check")).await;
    assert_eq!(call.map(|result| result.output), Err(ActionError::NotReady("disabled".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_check_moves_the_state() {
    let builtin = github();
    let rig = rig(vec![builtin.clone()], true).await;
    builtin.set_health(Event::Unauthorized);
    let (status, row) = rig.ask(Method::Post, "/api/capabilities/github/check", None).await;
    assert_eq!(
        (status, row["state"].as_str(), row["stateCode"].as_str()),
        (200, Some("needs_sign_in"), Some("http_401"))
    );
    builtin.set_health(Event::Passed);
    let (_, row) = rig.ask(Method::Post, "/api/capabilities/github/check", None).await;
    assert_eq!(row["state"], "ready");
    assert_eq!(builtin.checks(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_are_kept_and_only_declared_ones_are_taken() {
    let rig = rig(Vec::new(), true).await;
    rig.install(&notes("1.0.0"), "h-1").await;
    let path = "/api/capabilities/notes-db/settings";
    let (status, detail) = rig.ask(Method::Put, path, Some(r#"{"values": {"folder": "Work"}}"#)).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(
        detail["settings"],
        json!([{"name": "folder", "label": "Notes folder", "kind": "choice", "value": "Work"}])
    );
    assert_eq!(rig.ask(Method::Put, path, Some(r#"{"values": {"folder": "Garden"}}"#)).await.0, 400);
    assert_eq!(rig.ask(Method::Put, path, Some(r#"{"values": {"colour": "red"}}"#)).await.0, 400);
    let (_, detail) = rig.ask(Method::Put, path, Some(r#"{"values": {"folder": ""}}"#)).await;
    assert_eq!(detail["settings"][0].get("value"), None, "an empty value clears it");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kept_version_comes_back_and_a_removed_capability_is_gone() {
    let rig = rig(Vec::new(), true).await;
    rig.install(&notes("1.0.0"), "h-1").await;
    rig.clock.advance(1000);
    rig.install(&notes("1.1.0"), "h-2").await;
    let (_, detail) = rig.ask(Method::Get, "/api/capabilities/notes-db", None).await;
    let versions: Vec<&str> = detail["versions"]
        .as_array()
        .expect("versions")
        .iter()
        .map(|v| v["version"].as_str().expect("a version"))
        .collect();
    assert_eq!(versions, ["1.1.0", "1.0.0"], "newest first");
    assert_eq!(detail["reach"]["hosts"], json!(["notes.example.com"]));

    let (status, row) =
        rig.ask(Method::Post, "/api/capabilities/notes-db/rollback", Some(r#"{"version": "1.0.0"}"#)).await;
    assert_eq!((status, row["version"].as_str()), (200, Some("1.0.0")));
    assert_eq!(
        rig.ask(Method::Post, "/api/capabilities/notes-db/rollback", Some(r#"{"version": "9.9.9"}"#)).await.0,
        404
    );

    let (status, body) = rig.ask(Method::Delete, "/api/capabilities/notes-db", None).await;
    assert_eq!((status, body), (200, json!({"ok": true})));
    assert_eq!(rig.ask(Method::Get, "/api/capabilities/notes-db", None).await.0, 404);
    assert_eq!(rig.changes().last().map(String::as_str), Some(r#"{"id":"notes-db","state":"ready"}"#));
}

#[tokio::test(flavor = "multi_thread")]
async fn candidates_are_the_items_a_capability_offers_newest_first() {
    let item = |n: i64, at: i64| {
        json!({"key": format!("github:pr:acme/game#{n}"), "kind": "github.pull_request", "title": format!("PR {n}"),
            "url": format!("https://github.com/acme/game/pull/{n}"), "updatedAt": at, "data": {"number": n}})
    };
    let answer = json!({"items": [item(1, 100), item(2, 300), item(3, 200)]});
    let builtin = Arc::new(FakeBuiltin::new(GITHUB).answering("list_pull_requests", Ok(answer)));
    let rig = rig(vec![builtin.clone()], true).await;
    let (status, items) =
        rig.ask(Method::Get, "/api/capabilities/candidates?item=github.pull_request&q=fix&limit=2", None).await;
    assert_eq!(status, 200);
    assert_eq!(items, json!([item(2, 300), item(3, 200)]));
    assert_eq!(builtin.calls()[0].input, json!({"q": "fix", "limit": 2}));
    let (_, none) = rig.ask(Method::Get, "/api/capabilities/candidates?item=mail.message", None).await;
    assert_eq!(none, json!([]));
    assert_eq!(rig.ask(Method::Get, "/api/capabilities/candidates?limit=none", None).await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_reads_disables_and_checks_and_the_rest_stays_on_this_computer() {
    let rig = rig(vec![github()], true).await;
    rig.install(&notes("1.0.0"), "h-1").await;
    let routes: [(Method, &str, Option<&str>, Option<Tier>); 9] = [
        (Method::Get, "/api/capabilities", None, Some(Tier::Read)),
        (Method::Get, "/api/capabilities/candidates", None, Some(Tier::Read)),
        (Method::Get, "/api/capabilities/github", None, Some(Tier::Read)),
        (Method::Post, "/api/capabilities/github/disable", None, Some(Tier::Low)),
        (Method::Post, "/api/capabilities/github/check", None, Some(Tier::Low)),
        (Method::Post, "/api/capabilities/github/enable", None, None),
        (Method::Put, "/api/capabilities/notes-db/settings", Some(r#"{"values": {}}"#), None),
        (Method::Post, "/api/capabilities/notes-db/rollback", Some(r#"{"version": "1.0.0"}"#), None),
        (Method::Delete, "/api/capabilities/notes-db", None, None),
    ];
    let peer = Caller::Peer { device: "AB:CD".into(), human: true };
    for (method, path, body, phone) in routes {
        assert_eq!(
            rig.ask_as(Caller::UNTRUSTED, method, path, body).await.0,
            403,
            "{method:?} {path}: a page without the ui-token"
        );
        let read = Caller::Phone { grant: Tier::Read, mutate: true };
        let low = Caller::Phone { grant: Tier::Low, mutate: true };
        let (for_read, for_low) =
            (rig.ask_as(read, method, path, body).await.0, rig.ask_as(low, method, path, body).await.0);
        match phone {
            Some(Tier::Read) => assert_eq!((for_read, for_low), (200, 200), "{method:?} {path}"),
            Some(_) => assert_eq!((for_read, for_low), (403, 200), "{method:?} {path}"),
            None => assert_eq!((for_read, for_low), (403, 403), "{method:?} {path}: never the phone"),
        }
        let local_only =
            matches!(path, p if p.ends_with("/settings") || p.ends_with("/rollback")) || method == Method::Delete;
        if local_only {
            assert_eq!(
                rig.ask_as(peer.clone(), method, path, body).await.0,
                403,
                "{method:?} {path}: never a paired computer"
            );
        }
    }
}
