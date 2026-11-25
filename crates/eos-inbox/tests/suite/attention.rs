//! Attention (03 §4.7, G29): interrupts once and sparingly, quiet hours,
//! digests and the badge.

use std::sync::Arc;

use eos_core::net::relay::{PhonePush, PushKind};
use eos_core::store::{ConfigSource, StoredItem};
use eos_domain::inbox::ItemKind;
use eos_inbox::attention::{INTERRUPTS_PER_HOUR, NOTIFICATION_FIRE, Notifier, NotifierParts};
use eos_testkit::relay::FakePhoneNotify;
use eos_testkit::{FakeConfig, FakeDockBadge};
use serde_json::{Value, json};

use crate::rig::{Rig, new_item};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
/// 2025-01-01 00:00 UTC; the rig's clock is three hours ahead of it.
const DAY: i64 = 1_735_689_600_000;

/// `h:m` on the user's clock (UTC+3) on 2025-01-01.
fn local(h: i64, m: i64) -> i64 {
    DAY + (h - 3) * HOUR + m * MINUTE
}

struct Desk {
    rig: Rig,
    notifier: Notifier,
    phone: Arc<FakePhoneNotify>,
    badge: Arc<FakeDockBadge>,
    config: Arc<FakeConfig>,
}

fn desk(at: i64, attention: Value) -> Desk {
    let rig = Rig::new();
    rig.clock.set(at);
    let (phone, badge) = (Arc::new(FakePhoneNotify::new()), Arc::new(FakeDockBadge::new()));
    let config = Arc::new(FakeConfig::new(json!({ "attention": attention })));
    let notifier = Notifier::new(NotifierParts {
        store: rig.temp.port(),
        clock: rig.clock.clone(),
        zone: rig.zone.clone(),
        config: config.clone(),
        phone: phone.clone(),
        badge: badge.clone(),
    });
    Desk { rig, notifier, phone, badge, config }
}

impl Desk {
    /// A question about its own pull request, a minute after the last.
    async fn question(&self, n: u32) -> StoredItem {
        self.rig.clock.advance(MINUTE);
        let subject = format!("github:pr:acme/game#{n}@{n:040x}");
        self.rig.open(new_item(ItemKind::Question, Some(&subject))).await
    }

    fn banners(&self) -> Vec<Value> {
        let announced = self.rig.temp.announced.list();
        announced
            .into_iter()
            .filter(|(topic, _)| *topic == NOTIFICATION_FIRE)
            .map(|(_, payload)| serde_json::from_str(&payload).expect("JSON"))
            .collect()
    }
}

#[tokio::test]
async fn an_item_interrupts_once_with_a_count_and_no_content() {
    let d = desk(local(12, 0), json!({}));
    let item = d.question(1).await;
    d.notifier.pass().await.expect("a pass");
    d.notifier.pass().await.expect("a pass");

    let banners = d.banners();
    assert_eq!(banners.len(), 1, "once");
    assert_eq!(banners[0]["route"], format!("eos:/needs/{}", item.id));
    assert_eq!(
        (banners[0]["title"].as_str(), banners[0]["body"].as_str()),
        (Some("1 thing needs you"), Some("1 question"))
    );
    assert!(!banners[0].to_string().contains("482") && !banners[0].to_string().contains("Review"), "no title or text");
    assert_eq!(d.phone.pushes(), [PhonePush { kind: PushKind::NeedsYou, count: 1 }]);
    assert!(d.rig.find(&item.id).await.notified_at.is_some());

    // A digest-level draft never interrupts.
    d.rig.clock.advance(MINUTE);
    d.rig.open(new_item(ItemKind::Draft, Some("github:pr:acme/game#9@sha9"))).await;
    d.notifier.pass().await.expect("a pass");
    assert_eq!(d.banners().len(), 1);
}

#[tokio::test]
async fn the_seventh_in_an_hour_waits_for_the_digest() {
    let d = desk(local(10, 0), json!({}));
    for n in 0..7 {
        d.question(n).await;
        d.notifier.pass().await.expect("a pass");
    }
    assert_eq!(d.banners().len(), INTERRUPTS_PER_HOUR as usize);
    assert_eq!(d.phone.pushes().len(), 6);

    // An hour later the seventh still does not interrupt: it folded into the digest.
    d.rig.clock.set(local(11, 30));
    d.notifier.pass().await.expect("a pass");
    assert_eq!(d.banners().len(), 6);
    d.rig.clock.set(local(17, 0));
    assert_eq!(d.notifier.pass().await.expect("a pass"), local(22 + 10, 0), "the next is the end of quiet hours");
    let digest = d.banners().pop().expect("the digest");
    assert_eq!((digest["title"].as_str(), digest["body"].as_str()), (Some("7 things need you"), Some("7 questions")));
}

#[tokio::test]
async fn quiet_hours_fire_nothing_and_the_digest_at_their_end_counts_what_waited() {
    let d = desk(local(23, 0), json!({}));
    d.question(1).await;
    d.rig.clock.advance(MINUTE);
    d.rig.open(new_item(ItemKind::Draft, Some("github:pr:acme/game#2@sha2"))).await;
    d.question(3).await;
    assert_eq!(d.notifier.pass().await.expect("a pass"), local(24 + 8, 0));
    assert!(d.banners().is_empty() && d.phone.pushes().is_empty());

    d.rig.clock.set(local(24 + 8, 0));
    d.notifier.pass().await.expect("a pass");
    let banners = d.banners();
    assert_eq!(banners.len(), 1, "one digest, and nothing that waited interrupts after it");
    assert_eq!(
        (banners[0]["title"].as_str(), banners[0]["body"].as_str()),
        (Some("3 things need you"), Some("2 questions, 1 draft"))
    );
    assert!(d.phone.pushes().is_empty());

    // A digest time with nothing waiting says nothing.
    let quiet = desk(local(16, 0), json!({}));
    quiet.rig.clock.set(local(17, 0));
    quiet.notifier.pass().await.expect("a pass");
    assert!(quiet.banners().is_empty());
}

#[tokio::test]
async fn interrupts_none_or_urgent_hold_back_what_they_say() {
    let none = desk(local(12, 0), json!({ "interrupts": "none" }));
    none.question(1).await;
    none.notifier.pass().await.expect("a pass");
    assert!(none.banners().is_empty() && none.phone.pushes().is_empty());

    let urgent = desk(local(12, 0), json!({ "interrupts": "urgent" }));
    urgent.question(1).await;
    urgent.rig.clock.advance(MINUTE);
    let alert = urgent.rig.open(new_item(ItemKind::RoutineAlert, Some("failures"))).await;
    urgent.notifier.pass().await.expect("a pass");
    let banners = urgent.banners();
    assert_eq!(banners.len(), 1, "only the alert");
    assert_eq!(banners[0]["route"], format!("eos:/needs/{}", alert.id));
}

#[tokio::test]
async fn the_badge_shows_the_open_count() {
    let d = desk(local(12, 0), json!({}));
    d.notifier.badge(3);
    assert_eq!(d.badge.shown(), Some(3));
    d.notifier.badge(0);
    assert_eq!(d.badge.shown(), None);
}

#[tokio::test]
async fn new_settings_move_the_next_digest() {
    let d = desk(local(12, 0), json!({}));
    assert_eq!(d.notifier.pass().await.expect("a pass"), local(17, 0));
    let section = json!({ "digests": ["13:30"] }).as_object().cloned().expect("an object");
    d.config.patch("attention", section).expect("saved");
    d.notifier.settings_changed();
    assert_eq!(d.notifier.pass().await.expect("a pass"), local(13, 30));
}

#[tokio::test]
async fn a_digest_time_inside_quiet_hours_stays_quiet() {
    let d = desk(local(23, 0), json!({ "digests": ["23:30"] }));
    d.question(1).await;
    d.rig.clock.set(local(23, 30));
    assert_eq!(d.notifier.pass().await.expect("a pass"), local(24 + 8, 0), "the end of quiet hours is next");
    assert!(d.banners().is_empty());
}

#[tokio::test]
async fn an_item_opened_while_eos_was_closed_after_the_last_digest_still_interrupts() {
    let before = desk(local(12, 0), json!({}));
    let item = before.question(1).await;
    let parts = NotifierParts {
        store: before.rig.temp.port(),
        clock: before.rig.clock.clone(),
        zone: before.rig.zone.clone(),
        config: before.config.clone(),
        phone: before.phone.clone(),
        badge: before.badge.clone(),
    };
    before.rig.clock.advance(MINUTE);
    let restarted = Notifier::new(parts);
    restarted.pass().await.expect("a pass");
    let banners = before.banners();
    assert_eq!(banners.len(), 1);
    assert_eq!(banners[0]["route"], format!("eos:/needs/{}", item.id));
}
