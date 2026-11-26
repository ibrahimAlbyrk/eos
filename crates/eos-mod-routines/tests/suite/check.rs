//! A handed-in result: no checker reads it, the routine's checks are the
//! lead's to meet, and a result that does not fit is refused at hand-in
//! with what to fix.

use eos_contracts::RoutineState;
use eos_core::routine::{RunOrigin, SubmittedResult};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_runtime::module::Module;
use serde_json::{Value, json};

use eos_testkit::FakeCapabilityReads;

use crate::bench::{Bench, blueprint, new_run, pull_request};

/// PR Review with one check of its own.
fn checked() -> Value {
    let mut blueprint = blueprint(1);
    blueprint["how"]["checks"] = json!([{"key": "tests", "text": "Every finding names a test."}]);
    blueprint
}

fn review(headline: &str) -> SubmittedResult {
    SubmittedResult {
        kind: "github.review".into(),
        headline: headline.into(),
        body: json!({"summary": "SUMMARY-TEXT"}),
        files: vec![],
    }
}

/// A run whose lead works, and the lead.
async fn working(bench: &Bench, blueprint: Value) -> (String, String) {
    let routine = bench.routine(RoutineState::Active, blueprint);
    let id = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(3)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
    let lead = bench.run(&id).lead_id.expect("a lead");
    (id, lead)
}

fn is_checker(spec: &eos_core::agent::LaunchSpec) -> bool {
    spec.worker_definition.as_deref() == Some("eos-run-checker")
}

#[tokio::test(flavor = "multi_thread")]
async fn no_checker_reads_a_result_and_the_lead_is_told_the_routines_checks() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, checked()).await;
    let spec = bench.agents.started().into_iter().find(|s| s.worker_id == lead).expect("started");
    let brief = spec.prompt.expect("a brief");
    assert!(brief.contains("make sure it holds to these:\n- Every finding names a test."), "{brief}");

    bench.module.tools().submit_result(&lead, review("R")).await.expect("handed in");
    let ended = bench.run(&run);
    assert_eq!((ended.state, ended.station), (RunState::Done, Some(Station::Work)), "shown, straight from work");
    assert!(!bench.module.holds_worker(&lead));
    assert!(!bench.agents.started().iter().any(is_checker));
    let id = run.clone();
    let results = bench.temp.store.read_blocking(move |tx| tx.run_results().by_run(&id)).expect("reads");
    assert_eq!(results.len(), 1);
    assert!(results[0].verdict.is_none(), "no verdict is made");
    assert!(bench.module.tools().submit_result(&lead, review("Again")).await.is_err(), "one result per run");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_of_another_kind_is_refused_when_handed_in() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, checked()).await;
    let wrong = SubmittedResult { kind: "mail".into(), ..review("R") };
    let refused = bench.module.tools().submit_result(&lead, wrong).await.expect_err("refused");
    let told = refused.to_string();
    assert!(told.contains("kind `mail`: this routine makes `github.review`; hand in kind `github.review`."), "{told}");
    let at = bench.run(&run);
    assert_eq!((at.state, at.station, at.attempt), (RunState::Running, Some(Station::Work), 1), "no round spent");
    assert!(!bench.module.holds_worker(&lead));
    bench.module.tools().submit_result(&lead, review("R")).await.expect("the right kind is taken");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_the_channel_refuses_is_refused_when_handed_in_and_never_fails_at_a_check() {
    let reads = FakeCapabilityReads::new().refusing("github.review", "part `c:1`: a line comment needs meta.line.");
    let bench = Bench::with_reads(true, reads);
    let (run, lead) = working(&bench, checked()).await;
    let refused = bench.module.tools().submit_result(&lead, review("R")).await.expect_err("refused");
    assert!(refused.to_string().contains("(1) part `c:1`: a line comment needs meta.line."), "{refused}");
    let at = bench.run(&run);
    assert_eq!((at.state, at.station, at.attempt), (RunState::Running, Some(Station::Work), 1));
    assert!(!bench.module.holds_worker(&lead));
    assert!(!bench.agents.started().iter().any(is_checker));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_apps_reviewer_starts_read_only_in_its_build_run_and_never_leads_it() {
    let bench = Bench::new(true);
    let (run, lead) = working(&bench, checked()).await;
    let reviews = bench.module.app_reviews();
    let fence = eos_contracts::ToolScope {
        allow: ["Read", "Grep", "Glob", "LS"].map(String::from).to_vec(),
        deny: Vec::new(),
        edit_regex: None,
    };
    let start = eos_core::routine::AppReviewStart {
        run_id: run.clone(),
        name: "Game · App review".into(),
        model: "opus".into(),
        effort: "high".into(),
        fence,
        brief: "Review it. <untrusted source=\"app\">code</untrusted>".into(),
    };
    let reviewer = reviews.start_reviewer(start.clone()).await.expect("starts").expect("a reviewer");
    let spec = bench.agents.started().into_iter().find(|s| s.worker_id == reviewer).expect("started");
    assert_eq!(spec.worker_definition.as_deref(), Some("app-reviewer"));
    assert!(spec.prompt.as_deref().is_some_and(|prompt| prompt.ends_with(start.brief.as_str())), "{:?}", spec.prompt);
    assert_eq!(spec.model, "opus");
    let id = reviewer.clone();
    let session = bench.temp.store.read_blocking(move |tx| tx.routine_sessions().find(&id)).expect("reads");
    assert_eq!(session.map(|s| s.role).as_deref(), Some("app_reviewer"));
    let id = reviewer.clone();
    let row = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    let scope: eos_contracts::ToolScope =
        serde_json::from_str(row.tool_scope.as_deref().expect("a scope")).expect("json");
    assert_eq!(scope.allow, ["Read", "Glob", "Grep", "LS"], "it reads and runs nothing");
    assert_eq!(bench.run(&run).lead_id.as_deref(), Some(lead.as_str()), "the lead still leads");

    reviews.tell(&run, &lead, "Version 1 of the App passed.".into()).await.expect("told");
    bench
        .eventually(|| bench.agents.sent(&lead).iter().any(|text| text.contains("Version 1 of the App passed.")))
        .await;

    // A run that ended starts no reviewer.
    bench.runs.stop(&run, Reason::User).await.expect("stopped");
    assert_eq!(reviews.start_reviewer(start).await.expect("answers"), None);
}
