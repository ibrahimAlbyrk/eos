//! The routes over one send: a draft lists its sends, Stop in the hold
//! opens the draft again, and Undo, "that was wrong" and Retry refuse a
//! send that is not where they apply.

use eos_domain::inbox::ItemKind;
use eos_runtime::http::Method;
use serde_json::json;

use crate::rig::{Rig, new_item};

#[tokio::test(flavor = "multi_thread")]
async fn a_send_is_stopped_in_its_hold_and_the_others_refuse_what_does_not_apply() {
    let rig = Rig::new().await;
    let mut draft = new_item(ItemKind::Draft, "rt-1");
    draft.run_id = Some("rn-1".into());
    draft.payload = json!({
        "doc": {"kind": "github.review", "channel": "github", "action": "post_review",
                "parts": [{"key": "summary", "role": "summary", "text": "Looks good."}]},
        "targets": [{"recipientId": "pr", "place": {"item": "github:pr:acme/game#482"}}],
    });
    let item = rig.open(draft).await;
    let (_, sent) = rig.ask(Method::Post, &format!("/api/inbox/{}/send", item.id), Some(json!({"rev": 1}))).await;
    let id = sent["deliveries"][0]["id"].as_str().expect("an id").to_owned();

    let (status, shown) = rig.ask(Method::Get, &format!("/api/inbox/{}", item.id), None).await;
    assert_eq!(status, 200);
    assert_eq!(shown["deliveries"][0]["id"], json!(id));
    assert_eq!(shown["deliveries"][0]["state"], "holding");
    assert!(shown["deliveries"][0]["sendAt"].is_i64());

    let path = |action: &str| format!("/api/inbox/deliveries/{id}/{action}");
    let (status, stopped) = rig.ask(Method::Post, &path("stop"), None).await;
    assert_eq!((status, stopped["state"].clone()), (200, json!("stopped")), "{stopped}");
    let (_, shown) = rig.ask(Method::Get, &format!("/api/inbox/{}", item.id), None).await;
    assert_eq!(shown["item"]["state"], "open", "the draft waits for the user again");

    assert_eq!(rig.ask(Method::Post, &path("stop"), None).await.0, 409);
    assert_eq!(rig.ask(Method::Post, &path("undo"), None).await, (409, json!({"error": "cannot_undo"})));
    assert_eq!(rig.ask(Method::Post, &path("wrong"), None).await.0, 409);
    assert_eq!(rig.ask(Method::Post, &path("retry"), Some(json!({}))).await.0, 409);
    assert_eq!(rig.ask(Method::Post, "/api/inbox/deliveries/dl-none/stop", None).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_said_wrong_shows_so_and_freedom_reads_the_streak_since_the_last_offer() {
    let rig = Rig::new().await;
    for (n, outcome) in ["sent_edited", "sent_unedited", "expired", "sent_unedited"].iter().enumerate() {
        rig.temp.exec(&format!(
            "INSERT INTO inbox_outcomes (routine_id, run_id, outcome, rung, at) VALUES ('rt-1', 'rn-0', '{outcome}', 'draft', {n})"
        ));
    }
    let (status, freedom) = rig.ask(Method::Get, "/api/routines/rt-1/freedom", None).await;
    assert_eq!(status, 200, "{freedom}");
    assert_eq!(freedom, json!({"routineId": "rt-1", "rung": "draft", "grants": [], "streak": 2, "offer": "none"}));
    assert_eq!(rig.ask(Method::Get, "/api/routines/rt-none/freedom", None).await.0, 404);

    let mut draft = new_item(ItemKind::Draft, "rt-1");
    draft.run_id = Some("rn-0".into());
    let item = rig.open(draft).await;
    rig.temp.exec(&format!(
        "INSERT INTO inbox_deliveries (id, item_id, run_id, routine_id, channel, action, target, target_ref, class, \
         mode, state, body, body_hash, attempts, created_at, updated_at) VALUES ('dl-9', '{}', 'rn-0', 'rt-1', \
         'github', 'post_review', '{{}}', 'pr', 'speak', 'approved', 'sent', \
         '{{\"kind\":\"github.review\",\"channel\":\"github\",\"action\":\"post_review\",\"parts\":[]}}', \
         'h', 1, 1, 1)",
        item.id
    ));
    let (_, shown) = rig.ask(Method::Get, &format!("/api/inbox/{}", item.id), None).await;
    assert_eq!(shown["deliveries"][0].get("wrong"), None);
    assert_eq!(rig.ask(Method::Post, "/api/inbox/deliveries/dl-9/wrong", None).await.0, 200);
    let (_, shown) = rig.ask(Method::Get, &format!("/api/inbox/{}", item.id), None).await;
    assert_eq!(shown["deliveries"][0]["wrong"], true, "said once, it stays said after a reload");
    let (_, freedom) = rig.ask(Method::Get, "/api/routines/rt-1/freedom", None).await;
    assert_eq!(freedom["streak"], 0, "that was wrong ends it");
}
