//! Changing a page's design: saying what to change starts its designer on
//! the version the user saw; pointing removes or moves a part with no agent;
//! the user keeps the candidate, goes back, or brings an old version back,
//! and memory hears each.

use eos_core::experience::SurfaceSignalKind;
use eos_core::routine::RunOrigin;
use eos_runtime::http::Method;
use eos_surface::{MadeBy, VersionStatus};
use eos_testkit::FeedbackCall;
use serde_json::json;

use crate::designs::{candidate, paper, row};
use crate::rig::Rig;

fn heard(rig: &Rig) -> Vec<SurfaceSignalKind> {
    rig.feedback
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            FeedbackCall::Surface(signal) => Some(signal.kind),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn saying_what_to_change_starts_the_designer_on_the_version_the_user_saw() {
    let rig = paper().await;
    let asked = json!({"baseVersion": 1, "instruction": "The lead story smaller", "part": "lead", "index": 0});
    let (status, answer) = rig.ask(Method::Post, "/api/surfaces/sf-paper/reshape", Some(asked)).await;
    assert_eq!((status, answer["runId"].as_str()), (202, Some("rn-1")), "{answer}");
    let started = rig.runs.started();
    assert_eq!(started[0].origin, RunOrigin::Surface { surface_id: "sf-paper".into() });
    let design = started[0].input.surface.clone().expect("a design run");
    assert_eq!((design.base_version, design.instruction.as_deref()), (Some(1), Some("The lead story smaller")));
    assert_eq!(heard(&rig), [SurfaceSignalKind::Reshaped]);

    let stale = json!({"baseVersion": 7, "instruction": "Smaller"});
    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-paper/reshape", Some(stale)).await;
    assert_eq!(status, 409, "only from the design the page has");
}

#[tokio::test]
async fn pointing_makes_a_candidate_the_user_keeps_and_runs_fill_from_then_on() {
    let rig = paper().await;
    let moved = json!({"baseVersion": 1, "part": "list", "op": "move_up"});
    let (status, answer) = rig.ask(Method::Post, "/api/surfaces/sf-paper/arrange", Some(moved)).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!((answer["meta"]["version"].as_i64(), answer["meta"]["status"].as_str()), (Some(2), Some("candidate")));
    assert_eq!(answer["meta"]["note"], "Moved list up");
    let template = answer["body"]["template"].as_str().expect("a template");
    assert!(template.find("part=\"list\"") < template.find("part=\"lead\""), "{template}");
    assert_eq!(row(&rig, 2).await.made_by, MadeBy::Arrange);

    let (status, kept) = rig.ask(Method::Post, "/api/surfaces/sf-paper/versions/2/keep", None).await;
    assert_eq!((status, kept["meta"]["status"].as_str()), (200, Some("kept")), "{kept}");
    assert_eq!(row(&rig, 1).await.status, VersionStatus::Superseded);
    assert_eq!(candidate(&rig).await, None);
    let current = rig.temp.port().read(|tx| tx.surfaces().find("sf-paper")).await.expect("reads").expect("page");
    assert_eq!(current.current_version, Some(2));
    assert_eq!(heard(&rig), [SurfaceSignalKind::Reshaped, SurfaceSignalKind::KeptDesign]);

    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-paper/versions/2/keep", None).await;
    assert_eq!(status, 409, "a kept version is kept once");
    let nothing = json!({"baseVersion": 2, "part": "list", "op": "move_up"});
    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-paper/arrange", Some(nothing)).await;
    assert_eq!(status, 409, "the list is first now: nothing above it");
}

#[tokio::test]
async fn going_back_discards_the_candidate_and_an_old_version_comes_back_as_a_new_one() {
    let rig = paper().await;
    let removed = json!({"baseVersion": 1, "part": "list", "op": "remove"});
    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-paper/arrange", Some(removed)).await;
    assert_eq!(status, 200);
    let (status, back) = rig.ask(Method::Post, "/api/surfaces/sf-paper/versions/2/discard", None).await;
    assert_eq!((status, back["meta"]["status"].as_str()), (200, Some("discarded")));
    assert_eq!(candidate(&rig).await, None);
    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-paper/versions/2/keep", None).await;
    assert_eq!(status, 409);

    let (status, again) = rig.ask(Method::Post, "/api/surfaces/sf-paper/versions/2/restore", None).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!((again["meta"]["version"].as_i64(), again["meta"]["status"].as_str()), (Some(3), Some("candidate")));
    let v3 = row(&rig, 3).await;
    assert_eq!((v3.made_by, v3.base_version), (MadeBy::Restore, Some(2)));
    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-paper/versions/1/restore", None).await;
    assert_eq!(status, 409, "the version the page has is no earlier one");
    assert_eq!(heard(&rig), [SurfaceSignalKind::Reshaped, SurfaceSignalKind::Reverted]);
}
