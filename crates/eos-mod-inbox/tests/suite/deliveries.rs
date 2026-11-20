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
