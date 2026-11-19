//! Writes: on the rev the user saw, and the 409 that says why not.

use eos_domain::inbox::ItemKind;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use serde_json::json;

use crate::rig::{Rig, new_item};

#[tokio::test(flavor = "multi_thread")]
async fn the_second_answer_hears_who_answered_and_a_stale_rev_what_changed() {
    let rig = Rig::new().await;
    let item = rig.open(new_item(ItemKind::RoutineAlert, "rt-1")).await;
    let path = format!("/api/inbox/{}/answer", item.id);
    let body = json!({"rev": 1, "answer": {"kind": "routine_alert", "choice": "resume"}});
    let phone = Caller::Phone { grant: Tier::High, mutate: true };
    let (status, answered) = rig.ask_as(phone, Method::Post, &path, Some(body.clone())).await;
    assert_eq!((status, answered["state"].as_str(), answered["rev"].as_i64()), (200, Some("answered"), Some(2)));
    let (status, refused) = rig.ask(Method::Post, &path, Some(body)).await;
    assert_eq!(
        (status, refused),
        (409, json!({"error": "already answered", "state": "answered", "answeredBy": "phone"}))
    );

    let (_, detail) = rig.ask(Method::Get, &format!("/api/inbox/{}", item.id), None).await;
    assert_eq!(detail["answer"], json!({"kind": "routine_alert", "choice": "resume"}));
    assert_eq!(detail["answeredBy"], "phone");

    let notice = rig.open(new_item(ItemKind::Notice, "rt-1")).await;
    let later = format!("/api/inbox/{}/later", notice.id);
    assert_eq!(rig.ask(Method::Post, &later, Some(json!({"until": 5_000_000}))).await.0, 200);
    let stale = json!({"rev": 1, "answer": {"kind": "notice", "choice": "dismiss"}});
    let (status, changed) = rig.ask(Method::Post, &format!("/api/inbox/{}/answer", notice.id), Some(stale)).await;
    assert_eq!((status, changed), (409, json!({"error": "changed", "rev": 2})));
    let (status, _) =
        rig.ask(Method::Post, &format!("/api/inbox/{}/discard", notice.id), Some(json!({"rev": 2}))).await;
    assert_eq!(status, 200);
    let changes = rig.temp.announced.list();
    assert!(changes.iter().all(|(topic, _)| *topic == "inbox:change"));
    assert_eq!(changes.len(), 5, "each write is announced");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draft_keeps_edits_and_a_wrong_answer_is_refused() {
    let rig = Rig::new().await;
    let draft = rig.open(new_item(ItemKind::Draft, "rt-1")).await;
    let doc = json!({"kind": "github.review", "channel": "github", "action": "post_review",
        "parts": [{"key": "summary", "role": "summary", "text": "Looks good"}]});
    let path = format!("/api/inbox/{}/draft", draft.id);
    let (status, saved) = rig.ask(Method::Put, &path, Some(json!({"rev": 1, "doc": doc}))).await;
    assert_eq!((status, saved["rev"].as_i64()), (200, Some(2)));
    let (_, detail) = rig.ask(Method::Get, &format!("/api/inbox/{}", draft.id), None).await;
    assert_eq!(detail["working"]["parts"][0]["text"], "Looks good");
    assert_eq!(rig.ask(Method::Put, &path, Some(json!({"rev": 1, "doc": doc}))).await.0, 409);

    let answer = json!({"rev": 2, "answer": {"kind": "notice", "choice": "act"}});
    assert_eq!(rig.ask(Method::Post, &format!("/api/inbox/{}/answer", draft.id), Some(answer)).await.0, 400);
    assert_eq!(rig.ask(Method::Post, &format!("/api/inbox/{}/discard", draft.id), Some(json!({}))).await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shown_item_is_answered_through_its_own_route() {
    let rig = Rig::new().await;
    rig.run_worker("w-run");
    rig.ask_permission("p-run", "w-run", 2_000).await;
    let body = json!({"rev": 1, "answer": {"kind": "notice", "choice": "act"}});
    let (status, refused) = rig.ask(Method::Post, "/api/inbox/perm:p-run/answer", Some(body)).await;
    assert_eq!(
        (status, refused),
        (409, json!({"error": "answered through its own route", "routes": ["POST /pending/p-run/decision"]}))
    );
    let (status, refused) = rig.ask(Method::Post, "/api/inbox/sugg:um-abcdefgh/discard", Some(json!({"rev": 1}))).await;
    assert_eq!(status, 409);
    assert_eq!(
        refused["routes"],
        json!(["POST /api/user-memories/um-abcdefgh/approve", "POST /api/user-memories/um-abcdefgh/dismiss"])
    );
}
