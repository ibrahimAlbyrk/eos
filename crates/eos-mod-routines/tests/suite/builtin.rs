//! Built-in routines (01 G49): kept by their feature, hidden from the
//! user's list and never theirs to change; a milestone that names a system
//! step is run by its feature instead of the lead, then checked and gated.

use eos_contracts::RoutineState;
use eos_core::routine::{MilestoneDone, RunOrigin, StepResult, SubmittedResult};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_runtime::access::Caller;
use eos_runtime::http::Method;
use serde_json::{Value, json};

use crate::bench::{Bench, new_run};
use crate::project::project;
use crate::run_routes::Routes;

/// The project with a system step between the lead's two milestones.
fn with_step() -> Value {
    let mut blueprint = project();
    blueprint["how"]["checkAgent"] = json!(false);
    blueprint["project"]["milestones"] = json!([
        {"key": "build", "title": "Build it", "doneWhen": "it builds"},
        {"key": "test", "title": "Test it", "doneWhen": "its tests pass", "system": "forge.test"},
        {"key": "review", "title": "Review it", "doneWhen": "it reaches only what it says"},
    ]);
    blueprint
}

fn tested() -> StepResult {
    StepResult::Done(SubmittedResult {
        kind: "report".into(),
        headline: "Every test passed".into(),
        body: json!("3 of 3"),
        files: vec![],
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_builtin_routine_is_kept_by_its_feature_hidden_and_never_the_users_to_change() {
    let routes = Routes::new();
    let builtins = routes.bench.module.builtins();
    let id = builtins.ensure("forge", with_step()).await.expect("made");
    assert_eq!(builtins.ensure("forge", with_step()).await.expect("kept"), id, "the same routine");
    let versions = |id: &str| {
        let id = id.to_owned();
        routes.bench.temp.store.read_blocking(move |tx| tx.routine_versions().list(&id)).expect("reads")
    };
    assert_eq!(versions(&id).len(), 1, "an unchanged blueprint is no new version");
    let mut changed = with_step();
    changed["summary"] = json!("Builds what is missing.");
    builtins.ensure("forge", changed).await.expect("changed");
    assert_eq!(versions(&id).len(), 2);

    let triggers = routes.bench.module.directory().triggers().await.expect("reads");
    assert!(triggers.iter().all(|routine| routine.id != id), "no Mac holds it");
    let (_, list) = routes.get("/api/routines").await;
    assert!(list.as_array().expect("rows").iter().all(|row| row["id"] != json!(id)), "hidden from the list");
    let calls = [
        (Method::Put, format!("/api/routines/{id}/state"), json!({"state": "paused"})),
        (Method::Post, format!("/api/routines/{id}/copy"), json!({})),
        (Method::Delete, format!("/api/routines/{id}"), json!({})),
    ];
    for (method, path, body) in calls {
        let (status, answer) = routes.call(method, Caller::DASHBOARD, &path, Some(body)).await;
        assert_eq!(status, 409, "{path}: {answer}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_system_step_runs_instead_of_the_lead_and_goes_through_the_gate_before_the_next_milestone() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, with_step());
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    let brief = bench.agents.started()[0].prompt.clone().expect("the brief");
    assert!(brief.contains("`test`: Test it. Eos runs this one itself"), "{brief}");

    bench.steps.answer(tested());
    let tools = bench.module.tools();
    tools
        .complete_milestone(&lead, MilestoneDone { key: "build".into(), summary: "Built.".into(), files: vec![] })
        .await
        .expect("handed in");
    bench.eventually(|| bench.run(&run).progress_done == Some(2)).await;
    let calls = bench.steps.calls();
    assert_eq!((calls.len(), calls[0].step.as_str(), calls[0].milestone.as_str()), (1, "forge.test", "test"));
    assert_eq!((bench.state(&run), bench.run(&run).station), (RunState::Running, Some(Station::Work)));
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("next milestone, `review`"))).await;
    let id = run.clone();
    let headlines: Vec<String> = bench
        .temp
        .store
        .read_blocking(move |tx| tx.run_results().by_run(&id))
        .expect("reads")
        .into_iter()
        .map(|r| r.headline)
        .collect();
    assert_eq!(headlines, ["Build it", "Every test passed"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_system_step_that_fails_fails_its_run_with_its_reason() {
    let bench = Bench::new(true);
    let mut first = with_step();
    first["project"]["milestones"][0] =
        json!({"key": "test", "title": "Test it", "doneWhen": "-", "system": "forge.test"});
    first["project"]["milestones"][1] = json!({"key": "build", "title": "Build it", "doneWhen": "it builds"});
    bench.steps.answer(StepResult::Failed { reason: "Two tests failed under confinement.".into() });
    let routine = bench.routine(RoutineState::Active, first);
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    let failed = bench.run(&run);
    assert_eq!(
        (failed.reason, failed.headline.as_deref()),
        (Some(Reason::Reported), Some("Two tests failed under confinement."))
    );
}

/// The Forge's shape: a lead and a builder that names its definition.
fn forge_team() -> Value {
    let mut blueprint = with_step();
    blueprint["who"]["depth"] = json!("team");
    let agent = |key: &str, lead: bool, extra: Value| {
        let mut agent = json!({"key": key, "name": key, "lead": lead, "brief": format!("{key} brief."),
               "model": "sonnet", "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "shared"});
        agent.as_object_mut().expect("an object").extend(extra.as_object().cloned().unwrap_or_default());
        agent
    };
    blueprint["who"]["agents"] = json!([
        agent("lead", true, json!({"workspace": "none"})),
        agent("builder", false, json!({"definition": "forge-builder"})),
    ]);
    blueprint
}

fn scope_of(bench: &Bench, worker: &str) -> eos_contracts::ToolScope {
    let id = worker.to_owned();
    let row = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    serde_json::from_str(row.tool_scope.as_deref().expect("a scope")).expect("json")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_builtin_routines_lead_works_in_its_features_folder_and_its_agents_take_the_forge_roles_they_name() {
    let bench = Bench::new(true);
    let folder = bench.temp.home.join("scratch/forge-run");
    std::fs::create_dir_all(&folder).expect("a folder");
    let folder = folder.to_string_lossy().into_owned();
    bench.steps.give_folder(&folder);
    let id = bench.module.builtins().ensure("forge", forge_team()).await.expect("made");
    let start = || bench.start(new_run(&id, RunOrigin::Hand, None));
    let run = start().await.expect("starts").remove(0).id;
    let again = start().await.expect("starts").remove(0).id;
    assert_ne!(run, again, "each start of a built-in routine is a run of its own");
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    let started = bench.agents.started();
    assert_eq!(started.iter().find(|s| s.worker_id == lead).map(|s| s.cwd.clone()), Some(folder.clone()));

    bench.module.tools().start_specialist(&lead, "builder", "Build it.").await.expect("starts");
    let builder = bench.agents.started().into_iter().find(|s| s.parent_id.as_deref() == Some(&lead)).expect("one");
    assert_eq!((builder.worker_definition.as_deref(), builder.cwd.as_str()), (Some("forge-builder"), folder.as_str()));
    let scope = scope_of(&bench, &builder.worker_id);
    assert!(!scope.allow.iter().any(|tool| tool == "WebFetch" || tool == "call_capability"), "{scope:?}");
    assert!(scope.edit_regex.as_deref().is_some_and(|re| re.ends_with(r"(?!\.claude/)")), "{scope:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_users_routine_cannot_name_a_forge_definition() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, forge_team());
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    bench.module.tools().start_specialist(&lead, "builder", "Build it.").await.expect("starts");
    let builder = bench.agents.started().into_iter().find(|s| s.parent_id.as_deref() == Some(&lead)).expect("one");
    assert_eq!(builder.worker_definition.as_deref(), Some("eos-run-specialist"));
}
