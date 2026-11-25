//! A surface's kept designs and its saved state follow the user to their
//! other computers; candidates, issues and the surfaces of Eos's own
//! routines stay.

use std::sync::Arc;

use eos_core::net::sync::RecordSync;
use eos_core::store::StoredSurfaceState;
use eos_runtime::http::Method;
use eos_runtime::module::Module;
use eos_surface::{Level, Place, VersionStatus};
use serde_json::json;

use crate::rig::{Rig, issue, surface, version};

fn records(rig: &Rig) -> Arc<dyn RecordSync> {
    let contribution = rig.module.sync().into_iter().find(|c| c.domain == "surface").expect("the domain");
    contribution.handle.downcast_ref::<Arc<dyn RecordSync>>().expect("a record handle").clone()
}

fn routine(rig: &Rig, id: &str, origin: &str) {
    rig.temp.exec(&format!(
        "INSERT INTO routines (id, slug, name, kind, state, head_version_id, origin, created_at, updated_at, \
         changed_at) VALUES ('{id}', '{id}', 'Mail', 'standing', 'active', 'rv-1', '{origin}', 1, 1, 1)"
    ));
}

#[tokio::test]
async fn kept_designs_and_saved_state_travel_and_a_kept_design_never_changes() {
    let (air, pro) = (Rig::new().await, Rig::new().await);
    routine(&air, "rt-1", "hand");
    routine(&air, "rt-forge", "builtin");
    routine(&pro, "rt-1", "sync");
    let mut shown = surface("sf-a", "rt-1", Level::View, Place::NeedsYou, 1);
    (shown.current_version, shown.candidate_version) = (Some(1), Some(2));
    air.seed(
        vec![shown, surface("sf-forge", "rt-forge", Level::View, Place::NeedsYou, 2)],
        vec![version("sf-a", 1, VersionStatus::Kept), version("sf-a", 2, VersionStatus::Candidate)],
        vec![issue("si-1", "sf-a")],
    )
    .await;
    air.temp
        .port()
        .write(|tx, _| {
            tx.surface_state().put(&StoredSurfaceState {
                surface_id: "sf-a".into(),
                scope: String::new(),
                data_json: r#"{"filter":"urgent"}"#.into(),
                bytes: 19,
                updated_at: 7,
            })
        })
        .await
        .expect("saves");

    let items = records(&air).list().await.expect("lists");
    let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["sf-a/v1", "sf-a", "sf-a/state"], "no candidate, no issue, nothing of Eos's own");
    for item in &items {
        records(&pro).apply(&item.id, &item.data).await.expect("applies");
    }
    assert_eq!(records(&pro).list().await.expect("lists"), items, "the same records on both");
    let (status, state) = pro.ask(Method::Get, "/api/surfaces/sf-a/state", None).await;
    assert_eq!((status, state["data"].clone()), (200, json!({"filter": "urgent"})));
    assert_eq!(pro.temp.count("SELECT count(*) FROM surface_issues"), 0);

    let mut changed = items[0].data.clone();
    changed["bodyJson"] = json!(r#"{"template":"<p>other</p>"}"#);
    assert!(records(&pro).apply("sf-a/v1", &changed).await.is_err(), "a kept design never changes");
    let mut candidate = items[0].data.clone();
    candidate["status"] = json!("candidate");
    assert!(records(&pro).apply("sf-a/v3", &candidate).await.is_err(), "only kept designs travel");
}
