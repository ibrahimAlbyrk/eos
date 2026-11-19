//! A solo run at work: its lead started at the brief, the run tools, the
//! idle rule and a lead whose session dies.

use std::sync::atomic::Ordering;

use eos_contracts::{NameSource, RoutineState, SessionFactsRole};
use eos_core::routine::{RunOrigin, SubmittedResult};
use eos_domain::routine::run::{Reason, RunState, Station};
use serde_json::json;

use crate::bench::{Bench, blueprint, new_run, pull_request};

/// A routine whose `depth` option makes its editor think harder.
fn switching() -> serde_json::Value {
    let mut blueprint = blueprint(1);
    blueprint["options"][0]["affects"] =
        json!([{"agent": "editor", "model": {"deep": "opus"}, "effort": {"deep": "high"}}]);
    blueprint
}

/// Starts one run by hand and waits until its lead works.
async fn at_work(bench: &Bench, routine: &str, depth: &str) -> (String, String) {
    let mut new = new_run(routine, RunOrigin::Hand, Some(pull_request(7)));
    new.input.options.insert("depth".into(), json!(depth));
    new.input.note = Some("Mind the tests.".into());
    let id = bench.start(new).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
    let lead = bench.run(&id).lead_id.expect("a lead");
    (id, lead)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_solo_run_starts_its_lead_with_its_brief_then_goes_to_work() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, switching());
    let (run, lead) = at_work(&bench, &routine, "deep").await;

    let started = bench.agents.started();
    assert_eq!(started.len(), 1);
    let spec = &started[0];
    assert_eq!(spec.worker_id, lead, "the id the routine_sessions row was written with");
    assert_eq!(spec.role, SessionFactsRole::Focused);
    assert_eq!(spec.worker_definition.as_deref(), Some("eos-run-solo"));
    assert_eq!((spec.model.as_str(), spec.effort.as_deref()), ("opus", Some("high")), "the option switched them");
    let brief = spec.prompt.clone().expect("the brief");
    assert!(brief.contains("# Run of PR Review"), "{brief}");
    assert!(brief.contains("<untrusted source=\"github:pr:acme/game#7\">"), "outside text is wrapped: {brief}");
    assert!(brief.contains("Mind the tests.") && brief.contains("Depth: \"deep\""), "{brief}");

    let row = bench.sessions.store().read(move |tx| tx.workers().find(&lead)).await.expect("reads").expect("a row");
    assert_eq!(row.name.as_deref(), Some("PR Review · Editor"));
    assert_eq!(row.name_source, Some(NameSource::Auto));
    assert!(row.scratch, "its folder is a scratch folder of its own");
    assert!(bench.recents.0.lock().expect("recents").is_empty(), "a run's folder is no recent folder");
    let session = bench.temp.store.read_blocking(move |tx| tx.routine_sessions().find(&row.id)).expect("reads");
    let session = session.expect("written before the spawn");
    assert_eq!((session.role.as_str(), session.agent_key.as_deref()), ("solo", Some("editor")));
    assert_eq!(session.run_id.as_deref(), Some(run.as_str()));
    let stations: Vec<Option<String>> =
        bench.changes().iter().map(|change| change["station"].as_str().map(str::to_owned)).collect();
    assert_eq!(stations, [None, Some("brief".into()), Some("work".into())]);
}

#[tokio::test(flavor = "multi_thread")]
async fn submit_result_keeps_a_copy_with_its_files_and_the_run_waits_at_the_check() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let (run, lead) = at_work(&bench, &routine, "quick").await;
    let file = bench.temp.home.path().join("notes.md");
    std::fs::write(&file, "the notes").expect("a file");
    let tools = bench.module.tools();
    tools.report_progress(&lead, "Reading the diff", None).await.expect("noted");

    let result = SubmittedResult {
        kind: "github.review".into(),
        headline: "Two issues".into(),
        body: json!({"summary": "Looks fine."}),
        files: vec![file.to_string_lossy().into_owned()],
    };
    tools.submit_result(&lead, result.clone()).await.expect("handed in");
    std::fs::write(&file, "changed after").expect("a change");

    let stored = bench.run(&run);
    assert_eq!((stored.state, stored.station), (RunState::Checking, Some(Station::Check)));
    assert_eq!(stored.headline.as_deref(), Some("Two issues"));
    let id = run.clone();
    let results = bench.temp.store.read_blocking(move |tx| tx.run_results().by_run(&id)).expect("reads");
    assert_eq!(results.len(), 1);
    assert_eq!((results[0].attempt, results[0].kind.as_str()), (1, "github.review"));
    assert_eq!(results[0].body, r#"{"summary":"Looks fine."}"#);
    assert_eq!(results[0].files.as_deref(), Some(r#"[{"name":"notes.md","bytes":9}]"#));
    let kept = bench.temp.home.path().join(format!("routines/{routine}/runs/{run}/files/notes.md"));
    assert_eq!(std::fs::read_to_string(kept).expect("copied"), "the notes", "a copy, not the file itself");

    let again = tools.submit_result(&lead, result.clone()).await;
    assert_eq!(again, Err(eos_core::Error::Conflict("the run is not at work".into())));
    let stranger = tools.submit_result("w-chat", result).await;
    assert_eq!(stranger, Err(eos_core::Error::Conflict("this session works for no run".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_over_its_bound_is_refused_and_report_failure_ends_the_run() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let (run, lead) = at_work(&bench, &routine, "quick").await;
    let tools = bench.module.tools();
    let big = SubmittedResult {
        kind: "text".into(),
        headline: "h".into(),
        body: json!("x".repeat(600 * 1024)),
        files: vec![],
    };
    assert!(matches!(tools.submit_result(&lead, big).await, Err(eos_core::Error::Validation(_))));
    assert_eq!(bench.state(&run), RunState::Running);

    tools.report_failure(&lead, "The pull request was closed.").await.expect("reported");
    let stored = bench.run(&run);
    assert_eq!((stored.state, stored.reason), (RunState::Failed, Some(Reason::Reported)));
    assert_eq!(stored.headline.as_deref(), Some("The pull request was closed."));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lead_that_goes_quiet_is_reminded_once_then_the_run_fails() {
    let bench = Bench::new(true);
    bench.hooks.idle.store(true, Ordering::SeqCst);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let mut new = new_run(&routine, RunOrigin::Hand, Some(pull_request(7)));
    new.input.options.insert("depth".into(), json!("quick"));
    let run = bench.start(new).await.expect("starts").remove(0).id;
    bench.supervise().await;

    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    let stored = bench.run(&run);
    assert_eq!(stored.reason, Some(Reason::NoResult));
    let sent = bench.agents.sent(&stored.lead_id.expect("a lead"));
    assert_eq!(sent.len(), 1, "one reminder: {sent:?}");
    assert!(sent[0].starts_with(&format!("<system_message kind=\"routine_note\" run-id=\"{run}\"")), "{}", sent[0]);
    assert!(sent[0].contains("submit_result") && sent[0].contains("report_failure"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lead_whose_session_dies_is_resumed_once_then_the_run_fails() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let (run, lead) = at_work(&bench, &routine, "quick").await;
    bench.agents.settled().await;

    bench.agents.crash(&lead).await;
    bench.eventually(|| bench.agents.started().len() == 2).await;
    let resumed = &bench.agents.started()[1];
    assert_eq!(resumed.resume.as_deref().map(|_| ()), Some(()), "the same conversation goes on");
    bench.eventually(|| bench.agents.sent(&lead).len() == 1).await;
    assert!(bench.agents.sent(&lead)[0].contains("stopped unexpectedly"));
    assert_eq!(bench.state(&run), RunState::Running);

    bench.agents.settled().await;
    bench.agents.crash(&lead).await;
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    assert_eq!(bench.run(&run).reason, Some(Reason::Crashed));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lead_this_version_cannot_start_fails_the_run_and_says_why() {
    let bench = Bench::new(true);
    let mut script = blueprint(1);
    script["who"]["depth"] = json!("script");
    script["who"]["agents"] = json!([]);
    let source = "return 1;";
    script["who"]["script"] = json!({"source": source, "hash": eos_domain::routine::blueprint::hash(source)});
    let routine = bench.routine(RoutineState::Active, script);
    let run = bench.hand(&routine, Some(pull_request(1))).await;
    bench.supervise().await;
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    let stored = bench.run(&run);
    assert_eq!(stored.reason, Some(Reason::Invalid));
    assert!(stored.headline.as_ref().is_some_and(|line| line.contains("newer Eos")), "{:?}", stored.headline);
    assert!(bench.agents.started().is_empty());
}
