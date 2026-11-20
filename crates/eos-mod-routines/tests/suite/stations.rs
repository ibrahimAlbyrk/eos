//! Memory and surfaces at the stations: the lead's first start carries the
//! notes memory packed for its item, memory hears how runs end, and a
//! routine that makes a page takes its surface through its life.

use eos_contracts::RoutineState;
use eos_core::experience::RunPack;
use eos_core::routine::RunOrigin;
use eos_domain::routine::run::{RunState, Station};
use eos_runtime::access::Caller;
use eos_runtime::http::Method;
use eos_testkit::{FeedbackCall, SurfaceCall};
use serde_json::json;

use crate::bench::{Bench, blueprint, new_run, pull_request};
use crate::run_routes::Routes;

/// Starts one run by hand and waits until its lead works.
async fn at_work(bench: &Bench, routine: &str) -> (String, String) {
    let id = bench.start(new_run(routine, RunOrigin::Hand, Some(pull_request(5)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
    let lead = bench.run(&id).lead_id.expect("a lead");
    (id, lead)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_lead_starts_with_the_notes_for_its_item_and_a_resume_starts_without_them() {
    let bench = Bench::new(true);
    bench.packs.set(RunPack {
        text: "NOTES-BLOCK".into(),
        note_ids: vec!["n-1".into()],
        example_ids: vec![],
        tokens: 3,
    });
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let (run, lead) = at_work(&bench, &routine).await;
    let first = bench.agents.started().into_iter().find(|s| s.worker_id == lead).expect("started");
    assert!(first.notes.iter().any(|note| note == "NOTES-BLOCK"), "{:?}", first.notes);
    let asked = bench.packs.requests();
    assert_eq!(asked.len(), 1);
    assert_eq!((asked[0].run_id.as_str(), asked[0].routine_id.as_str()), (run.as_str(), routine.as_str()));
    assert!(asked[0].item_text.contains("Fix the login") && !asked[0].trial, "{:?}", asked[0]);
    assert_eq!(asked[0].project, None, "a scratch folder is no project");

    bench.agents.settled().await;
    bench.agents.crash(&lead).await;
    bench.eventually(|| bench.agents.started().len() == 2).await;
    let resumed = &bench.agents.started()[1];
    assert!(!resumed.notes.iter().any(|note| note == "NOTES-BLOCK"), "only the first start carries the pack");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_ends_is_told_to_memory_with_how_it_ended() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let (run, lead) = at_work(&bench, &routine).await;
    bench.module.tools().report_failure(&lead, "The pull request was closed.").await.expect("reported");
    assert_eq!(bench.state(&run), RunState::Failed);
    let ended = || {
        bench.feedback.calls().iter().any(|call| {
            matches!(call, FeedbackCall::RunEnded(outcome)
                if outcome.run_id == run && outcome.routine_id == routine && outcome.kind == "failed")
        })
    };
    bench.eventually(ended).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_that_makes_a_page_takes_its_surface_through_its_life() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let mut page = blueprint(1);
    page["makes"] = json!({"kind": "page", "description": "A page."});
    let routine = bench.routine(RoutineState::Active, page);
    let other = bench.routine(RoutineState::Active, blueprint(1));
    for id in [&routine, &other] {
        let state = format!("/api/routines/{id}/state");
        for to in ["archived", "active"] {
            let (status, _) = routes.call(Method::Put, Caller::DASHBOARD, &state, Some(json!({"state": to}))).await;
            assert_eq!(status, 200);
        }
        let path = format!("/api/routines/{id}");
        assert_eq!(routes.call(Method::Delete, Caller::DASHBOARD, &path, None).await.0, 200);
        assert_eq!(routes.post(&format!("{path}/undelete"), json!({})).await.0, 200);
    }
    let r = || routine.clone();
    assert_eq!(
        bench.surfaces.calls(),
        [SurfaceCall::Archive(r()), SurfaceCall::Restore(r()), SurfaceCall::Archive(r()), SurfaceCall::Restore(r())],
        "a routine whose result is no surface asks nothing"
    );
}
