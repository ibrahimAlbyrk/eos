//! Sending a held draft: one delivery per target, read back by id; a stale
//! rev and a second send are refused with what changed.

use eos_domain::inbox::ItemKind;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use serde_json::json;

use crate::rig::{Rig, new_item};

fn review() -> serde_json::Value {
    json!({"kind": "github.review", "channel": "github", "action": "post_review",
           "parts": [{"key": "summary", "role": "summary", "text": "Looks good."}]})
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_answers_its_deliveries_and_each_reads_back() {
    let rig = Rig::new().await;
    let mut draft = new_item(ItemKind::Draft, "rt-1");
    draft.run_id = Some("rn-1".into());
    draft.payload = json!({
        "doc": review(),
        "targets": [{"recipientId": "pr", "place": {"item": "github:pr:acme/game#482"}}],
        "rung": "draft",
        "untrusted": true,
    });
    let item = rig.open(draft).await;
    let path = format!("/api/inbox/{}/send", item.id);

    let (status, changed) = rig.ask(Method::Post, &path, Some(json!({"rev": 7}))).await;
    assert_eq!((status, changed), (409, json!({"error": "changed", "rev": 1})));

    let phone = Caller::Phone { grant: Tier::High, mutate: true };
    let (status, sent) = rig.ask_as(phone, Method::Post, &path, Some(json!({"rev": 1, "doc": review()}))).await;
    assert_eq!(status, 200, "{sent}");
    let deliveries = sent["deliveries"].as_array().expect("deliveries");
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0]["state"], "queued");
    assert!(deliveries[0]["sendAt"].is_i64());

    let id = deliveries[0]["id"].as_str().expect("an id");
    let (status, delivery) = rig.ask(Method::Get, &format!("/api/inbox/deliveries/{id}"), None).await;
    assert_eq!(status, 200);
    assert_eq!((delivery["itemId"].as_str(), delivery["mode"].as_str()), (Some(item.id.as_str()), Some("approved")));
    assert_eq!((delivery["targetRef"].as_str(), delivery["body"].clone()), (Some("pr"), review()));
    assert!(delivery["approvedAt"].is_i64());

    let (status, again) = rig.ask(Method::Post, &path, Some(json!({"rev": 2}))).await;
    assert_eq!(
        (status, again),
        (409, json!({"error": "already answered", "state": "answered", "answeredBy": "phone"}))
    );
    assert_eq!(rig.ask(Method::Get, "/api/inbox/deliveries/dl-none", None).await.0, 404);
}
