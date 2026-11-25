//! The `notify` built-in and channel: a "tell me" result shows as a banner
//! here and wakes the phone with a kind and a count only; it tells no one
//! but the user, and a phone that cannot be reached leaves the banner.

use std::sync::{Arc, Mutex};

use eos_capabilities::Notify;
use eos_contracts::{Part, ResultDoc};
use eos_core::agent::UserNotifier;
use eos_core::capability::{ActionContext, BuiltinCapability};
use eos_core::delivery::{Place, SendRequest, Target};
use eos_core::net::relay::{PhonePush, PushKind, PushOutcome};
use eos_domain::capability::check::check_builtin;
use eos_domain::capability::health::Event;
use eos_testkit::relay::FakePhoneNotify;

use crate::rig::{Rig, Setup, rig};

/// The banners shown, as (title, body).
#[derive(Default)]
struct Banners(Mutex<Vec<(String, String)>>);

impl UserNotifier for Banners {
    fn notify(&self, _worker_id: &str, title: &str, body: &str) {
        self.0.lock().expect("banners").push((title.to_owned(), body.to_owned()));
    }
}

async fn notify_rig() -> (Rig, Arc<Banners>, Arc<FakePhoneNotify>) {
    let (banners, phone) = (Arc::new(Banners::default()), Arc::new(FakePhoneNotify::new()));
    let notify = Arc::new(Notify::new(banners.clone(), phone.clone()));
    let rig = rig(Setup { builtins: vec![notify], ..Setup::default() }).await;
    (rig, banners, phone)
}

fn told(place: Place) -> SendRequest {
    let body =
        Part { key: "body".into(), role: "body".into(), text: "Three mails came in.".into(), meta: Default::default() };
    SendRequest {
        key: "dl-000000000001".into(),
        run_id: "rn-1".into(),
        channel: "notify".into(),
        action: "tell".into(),
        target: Target { recipient_id: "me".into(), place },
        body: ResultDoc { kind: "text".into(), channel: "notify".into(), action: "tell".into(), parts: vec![body] },
    }
}

#[tokio::test]
async fn a_tell_me_result_is_a_banner_here_and_a_kind_and_count_on_the_phone() {
    let (rig, banners, phone) = notify_rig().await;
    let channel = rig.service.channels().get("notify").expect("a notify channel");
    channel.send(&told(Place::Me)).await.expect("told");
    assert_eq!(*banners.0.lock().expect("banners"), [("Eos".to_owned(), "Three mails came in.".to_owned())]);
    assert_eq!(phone.pushes(), [PhonePush { kind: PushKind::Ready, count: 1 }]);

    assert!(channel.send(&told(Place::Address("someone@else.dev".into()))).await.is_err(), "only the user");
    assert_eq!(phone.pushes().len(), 1);
}

#[tokio::test]
async fn a_phone_out_of_reach_leaves_the_banner_and_the_send_stands() {
    let (rig, banners, phone) = notify_rig().await;
    phone.answer(Ok(PushOutcome::LinkOff));
    rig.service.channels().get("notify").expect("a channel").send(&told(Place::Me)).await.expect("told");
    assert_eq!(banners.0.lock().expect("banners").len(), 1);
}

#[tokio::test]
async fn its_manifest_passes_the_check_and_its_health_needs_no_phone() {
    let notify = Notify::new(Arc::new(Banners::default()), Arc::new(FakePhoneNotify::new()));
    assert_eq!(check_builtin(notify.manifest()), []);
    let ctx = ActionContext { secrets: Default::default(), settings: serde_json::json!({}), idempotency_key: None };
    assert_eq!(notify.health(&ctx).await, Event::Passed);
}
