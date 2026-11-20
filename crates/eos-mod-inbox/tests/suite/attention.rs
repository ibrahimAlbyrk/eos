//! `GET`/`PUT /api/settings/attention`, and the Dock badge following the
//! open count.

use std::time::Duration;

use eos_domain::inbox::ItemKind;
use eos_runtime::access::Caller;
use eos_runtime::http::Method;
use serde_json::json;

use crate::rig::{Rig, new_item};

const PATH: &str = "/api/settings/attention";

#[tokio::test]
async fn the_settings_read_their_defaults_round_trip_and_refuse_a_bad_time() {
    let rig = Rig::new().await;
    let defaults = json!({
        "quietOn": true, "quietFrom": "22:00", "quietTo": "08:00", "digests": ["09:00", "17:00"], "interrupts": "all"
    });
    assert_eq!(rig.ask(Method::Get, PATH, None).await, (200, defaults.clone()));

    let mine = json!({
        "quietOn": false, "quietFrom": "23:30", "quietTo": "07:00", "digests": ["12:00"], "interrupts": "urgent"
    });
    assert_eq!(rig.ask(Method::Put, PATH, Some(mine.clone())).await, (200, mine.clone()));
    assert_eq!(rig.ask(Method::Get, PATH, None).await, (200, mine.clone()));

    let bad = json!({ "quietOn": true, "quietFrom": "25:00", "quietTo": "08:00", "digests": [], "interrupts": "all" });
    assert_eq!(rig.ask(Method::Put, PATH, Some(bad)).await.0, 400);
    let loud =
        json!({ "quietOn": true, "quietFrom": "22:00", "quietTo": "08:00", "digests": [], "interrupts": "loud" });
    assert_eq!(rig.ask(Method::Put, PATH, Some(loud)).await.0, 400);
    assert_eq!(rig.ask(Method::Get, PATH, None).await, (200, mine), "nothing was written");

    // Only the user's own dashboard writes them.
    let agent = rig.ask_as(Caller::UNTRUSTED, Method::Put, PATH, Some(defaults)).await;
    assert_eq!(agent.0, 403);
}

#[tokio::test]
async fn the_badge_follows_the_open_count() {
    let rig = Rig::new().await;
    let item = rig.open(new_item(ItemKind::Question, "rt-1")).await;
    rig.open(new_item(ItemKind::Notice, "rt-2")).await;
    shown(&rig, Some(2)).await;

    let (status, _) =
        rig.ask(Method::Post, &format!("/api/inbox/{}/discard", item.id), Some(json!({ "rev": item.rev }))).await;
    assert_eq!(status, 200);
    shown(&rig, Some(1)).await;
}

async fn shown(rig: &Rig, expected: Option<u32>) {
    for _ in 0..500 {
        if rig.badge.shown() == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(rig.badge.shown(), expected);
}
