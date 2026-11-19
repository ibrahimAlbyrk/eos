//! Only the user's dashboard and phone reach Needs you, the phone by tier.

use eos_domain::inbox::ItemKind;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use serde_json::{Value, json};

use crate::rig::{Rig, new_item};

#[tokio::test(flavor = "multi_thread")]
async fn each_route_needs_the_user_and_the_phone_its_tier() {
    let rig = Rig::new().await;
    let item = rig.open(new_item(ItemKind::Notice, "rt-1")).await;
    let id = &item.id;
    let routes: [(Method, String, Option<Value>, Tier); 6] = [
        (Method::Get, "/api/inbox".into(), None, Tier::Read),
        (Method::Get, format!("/api/inbox/{id}"), None, Tier::Read),
        (Method::Put, format!("/api/inbox/{id}/draft"), Some(json!({})), Tier::Low),
        (Method::Post, format!("/api/inbox/{id}/later"), Some(json!({})), Tier::Low),
        (Method::Post, format!("/api/inbox/{id}/discard"), Some(json!({})), Tier::Low),
        (Method::Post, format!("/api/inbox/{id}/answer"), Some(json!({})), Tier::High),
    ];
    let allowed = |status: u16| status != 403;
    for (method, path, body, tier) in routes {
        let (status, _) = rig.ask_as(Caller::UNTRUSTED, method, &path, body.clone()).await;
        assert_eq!(status, 403, "{method:?} {path}: a page without the ui-token");
        let without_the_user = Caller::Phone { grant: Tier::High, mutate: false };
        assert_eq!(rig.ask_as(without_the_user, method, &path, body.clone()).await.0, 403, "{method:?} {path}");
        for grant in [Tier::Read, Tier::Low, Tier::High] {
            let phone = Caller::Phone { grant, mutate: true };
            let status = rig.ask_as(phone, method, &path, body.clone()).await.0;
            assert_eq!(allowed(status), grant >= tier, "{method:?} {path} with {grant:?}: {status}");
        }
    }
}
