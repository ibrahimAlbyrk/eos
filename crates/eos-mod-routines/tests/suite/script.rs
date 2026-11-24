//! Script depth (01 G9, D52): the lead runs the kept script by its path,
//! read and hashed by Eos's gate and passed inline; every other Workflow
//! call is refused.

use eos_contracts::{RoutineState, UnknownRecord};
use eos_core::policy::ScriptCall;
use eos_core::routine::RunOrigin;
use eos_domain::routine::run::Station;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

const SOURCE: &str = "export default async function () { return args.item.title; }";

fn scripted() -> Value {
    let mut scripted = blueprint(1);
    scripted["who"]["depth"] = json!("script");
    scripted["who"]["agents"] = json!([]);
    scripted["who"]["script"] = json!({"source": SOURCE, "hash": eos_domain::routine::blueprint::hash(SOURCE)});
    scripted
}

fn record(value: Value) -> UnknownRecord {
    serde_json::from_value(value).expect("an object")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_lead_runs_the_kept_script_inline_and_every_other_workflow_call_is_refused() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, scripted());
    let run =
        bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(4)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    let started = &bench.agents.started()[0];
    assert_eq!((started.worker_definition.as_deref(), started.model.as_str()), (Some("eos-run-script"), "haiku"));
    let version = bench.run(&run).version_id.expect("a version");
    let path = bench.temp.home.path().join("routines").join(&routine).join("scripts").join(format!("{version}.js"));
    assert_eq!(std::fs::read_to_string(&path).expect("kept"), SOURCE);
    let brief = started.prompt.clone().expect("the brief");
    assert!(brief.contains(&path.to_string_lossy().to_string()) && brief.contains("\"now\""), "{brief}");

    let scripts = bench.module.scripts();
    let args = json!({"item": {"title": "Fix it"}, "now": 1});
    let asked = record(json!({"scriptPath": path.to_string_lossy(), "args": args}));
    let ran = scripts.check(&lead, &asked).await.expect("checks");
    assert_eq!(ran, ScriptCall::Run(record(json!({"script": SOURCE, "args": args}))));

    let refused = |answer: ScriptCall| matches!(answer, ScriptCall::Refused(_));
    for other in [
        json!({"scriptPath": "/tmp/other.js", "args": args}),
        json!({"name": "review"}),
        json!({"script": SOURCE, "args": args}),
        json!({"scriptPath": path.to_string_lossy(), "resumeFromRunId": "wr-1"}),
    ] {
        assert!(refused(scripts.check(&lead, &record(other.clone())).await.expect("checks")), "{other}");
    }
    std::fs::write(&path, format!("{SOURCE}\n// changed")).expect("writes");
    assert!(refused(scripts.check(&lead, &asked).await.expect("checks")), "a changed file");
    std::fs::remove_file(&path).expect("removes");
    std::os::unix::fs::symlink("/etc/hosts", &path).expect("links");
    assert!(refused(scripts.check(&lead, &asked).await.expect("checks")), "a link is no kept script");
    assert_eq!(scripts.check("w-chat", &asked).await.expect("checks"), ScriptCall::NotOurs, "a session of no run");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_solo_lead_has_no_script_to_run() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let run =
        bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(4)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    let answer = bench.module.scripts().check(&lead, &record(json!({"name": "saved"}))).await.expect("checks");
    assert!(matches!(answer, ScriptCall::Refused(_)), "{answer:?}");
}
