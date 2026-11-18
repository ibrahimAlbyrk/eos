//! Question 1: a focused session's Workflow call with `scriptPath` and
//! `args` (01 G9). The script only returns the `args` it was given, so the
//! run's report shows whether they arrived.

use std::path::Path;

use engine_run_options::bench::{Bench, Dirs, focused};
use engine_run_options::gate::{RecordingGate, SeenCall};
use engine_run_options::requests::{answers, notification, show, text_of, tool_of, tool_result, tools_of};
use eos_agent_core::Workspace;
use eos_agent_mock_api::Reply;
use eos_agent_sdk::AgentOptions;
use serde_json::{Value, json};

const SCRIPT: &str = "export const meta = {name: 'probe', description: 'Echo the run input', phases: [{title: 'Echo'}]}\n\
return {got: args}\n";
const CALL: &str = "toolu_wf";
const REFUSED: &str = "scriptPath must be a script path this tool returned, or a file you can already read";

/// The run input 01 G9 passes: item, options, note.
fn args() -> Value {
    json!({"item": {"kind": "pr", "key": "octo/repo#7", "untrusted": true}, "options": {"depth": 2}, "note": "focus on tests"})
}

fn by_path(path: &Path) -> Value {
    json!({"scriptPath": path, "args": args()})
}

/// The lead calls Workflow with `input`, then answers the result and the
/// run's report in plain text.
fn lead(input: Value) -> impl Fn(&Value) -> Reply + Send + Sync + 'static {
    move |body| {
        if text_of(body).contains("<task-notification>") {
            Reply::text("noted")
        } else if answers(body, CALL) {
            Reply::text("waiting for the run")
        } else {
            Reply::tool_use(CALL, "Workflow", &input.to_string())
        }
    }
}

struct Outcome {
    first: Value,
    result: (String, bool),
    report: Option<String>,
    gate: Vec<SeenCall>,
}

async fn launch(dirs: &Dirs, gate: RecordingGate, options: AgentOptions, input: Value) -> Outcome {
    let bench = Bench::start(dirs, gate, lead(input)).await;
    let _agent = bench.run(options, "Run the routine's script.").await;
    let requests = bench.requests();
    Outcome {
        first: requests[0].clone(),
        result: tool_result(&requests, CALL).expect("the Workflow call was answered"),
        report: notification(&requests),
        gate: bench.gate.workflow_calls(),
    }
}

/// The run started, completed, and its result is the `args` it was given.
fn ran_with_args(out: &Outcome) {
    let (text, error) = &out.result;
    assert!(!error && text.starts_with("Workflow launched in background."), "{text}");
    let report = out.report.as_deref().expect("the run's report reached the lead");
    assert!(report.contains("<status>completed</status>"), "{report}");
    let result = report.split("<result>").nth(1).and_then(|r| r.split("</result>").next()).expect("a result");
    let result: Value = serde_json::from_str(result).expect("the result is JSON");
    assert_eq!(result, json!({"got": args()}), "the script got the args verbatim");
}

fn refused(out: &Outcome, path: &Path) {
    let (text, error) = &out.result;
    assert!(*error && text.contains(REFUSED) && text.contains(&path.display().to_string()), "{text}");
    assert!(out.report.is_none(), "no run started");
}

fn print_result(label: &str, out: &Outcome) {
    println!("----- {label} -----");
    println!("Workflow result (error: {}):\n{}", out.result.1, out.result.0);
    println!("report: {}\n", out.report.as_deref().unwrap_or("(none)").trim());
}

#[tokio::test]
async fn a_script_inside_the_working_directory_runs_with_its_args() {
    let dirs = Dirs::new();
    let script = dirs.write("project/scripts/probe.js", SCRIPT);
    let out = launch(&dirs, RecordingGate::default(), focused(&dirs, "w-cwd"), by_path(&script)).await;
    show("Q1, focused session (first request)", &out.first);
    print_result("Q1, scriptPath inside cwd", &out);

    assert!(tools_of(&out.first).iter().any(|t| t == "Workflow"), "a focused session is offered Workflow");
    let properties = tool_of(&out.first, "Workflow").expect("Workflow")["input_schema"]["properties"].clone();
    assert!(properties.get("scriptPath").is_some() && properties.get("args").is_some(), "{properties}");
    ran_with_args(&out);
    // The gate sees the script the path names, and the args, in the review.
    let review = out.gate[0].review.clone().expect("a review");
    assert_eq!(review["script"], SCRIPT);
    assert_eq!(review["args"], args());
    assert_eq!(out.gate[0].input, by_path(&script), "the call itself names only the path");
}

#[tokio::test]
async fn a_script_inside_a_further_root_runs() {
    let dirs = Dirs::new();
    let script = dirs.write("extra/probe.js", SCRIPT);
    let out = launch(&dirs, RecordingGate::default(), focused(&dirs, "w-root"), by_path(&script)).await;
    print_result("Q1, scriptPath inside a further root", &out);
    ran_with_args(&out);
}

#[tokio::test]
async fn a_script_in_the_agents_scratch_folder_runs() {
    let dirs = Dirs::new();
    let id = "w-scratch";
    let script = dirs.scratch(id).join("probe.js");
    std::fs::create_dir_all(dirs.scratch(id)).expect("a folder");
    std::fs::write(&script, SCRIPT).expect("written");
    let out = launch(&dirs, RecordingGate::default(), focused(&dirs, id), by_path(&script)).await;
    print_result("Q1, scriptPath in the scratch folder", &out);
    ran_with_args(&out);
}

#[tokio::test]
async fn a_script_in_the_routines_folder_is_refused() {
    let dirs = Dirs::new();
    let script = dirs.write("eos/routines/rt-1/scripts/rv-1.js", SCRIPT);
    let out = launch(&dirs, RecordingGate::default(), focused(&dirs, "w-routines"), by_path(&script)).await;
    print_result("Q1, scriptPath in ~/.eos/routines (outside every root)", &out);
    refused(&out, &script);
    let review = out.gate[0].review.clone().expect("a review");
    assert!(review.get("script").is_none(), "the review cannot load it either: {review}");
}

#[tokio::test]
async fn the_routines_folder_as_a_root_loads_but_becomes_writable() {
    let dirs = Dirs::new();
    let scripts = dirs.routines().join("rt-1/scripts");
    let script = dirs.write("eos/routines/rt-1/scripts/rv-1.js", SCRIPT);
    let options = focused(&dirs, "w-root-routines").roots(vec![dirs.extra(), scripts.clone()]);
    let out = launch(&dirs, RecordingGate::default(), options, by_path(&script)).await;
    print_result("Q1, the routine's scripts folder given as a root", &out);
    ran_with_args(&out);

    // The engine's write rule for the same session: a root is inside, and a
    // protected path inside the roots is no longer refused.
    let protected = vec![dirs.routines()];
    let scratch = dirs.scratch("w");
    let without = Workspace::new(dirs.project(), vec![dirs.extra()], scratch.clone()).with_protected(protected.clone());
    let with = Workspace::new(dirs.project(), vec![dirs.extra(), scripts], scratch).with_protected(protected);
    assert!(!without.may_write(&script), "protected while outside the roots");
    assert!(with.may_write(&script) && with.write_target(&script).inside, "a root's files are the agent's to edit");
}

/// The engine lets a session read its folder's workflow files unasked (every
/// session of the working directory) and write only its own session's
/// scripts: a script Eos puts there loads, and file tools cannot rewrite it.
#[tokio::test]
async fn a_script_in_the_engines_folder_for_the_project_loads_and_stays_read_only() {
    let dirs = Dirs::new();
    let folder = dirs.engine().join("workflows").join(eos_agent_compat::project_dir_name(&dirs.project()));
    let script = folder.join("routines/rv-1.js");
    std::fs::create_dir_all(folder.join("routines")).expect("a folder");
    std::fs::write(&script, SCRIPT).expect("written");
    let write = json!({"file_path": script, "content": "export const meta = {name: 'x', description: 'x'}\nreturn 1"});
    let launch = lead(by_path(&script));
    let respond = move |body: &Value| {
        if answers(body, CALL) {
            Reply::tool_use("toolu_write", "Write", &write.to_string())
        } else if answers(body, "toolu_write") {
            Reply::text("tried")
        } else {
            launch(body)
        }
    };
    let bench = Bench::start(&dirs, RecordingGate::default(), respond).await;
    let _agent = bench.run(focused(&dirs, "w-engine"), "Run the routine's script.").await;
    let requests = bench.requests();
    let out = Outcome {
        first: requests[0].clone(),
        result: tool_result(&requests, CALL).expect("answered"),
        report: notification(&requests),
        gate: bench.gate.workflow_calls(),
    };
    print_result("Q1, scriptPath in the engine's workflow folder for the project", &out);
    ran_with_args(&out);
    let (text, error) = tool_result(&requests, "toolu_write").expect("the write was answered");
    println!("Write to that script (error: {error}): {text}\n");
    assert!(error && text.contains("is in the agent engine's own files, which tools do not write."), "{text}");
    assert_eq!(std::fs::read_to_string(&script).expect("still there"), SCRIPT);
}

#[tokio::test]
async fn an_inline_script_gets_its_args_too() {
    let dirs = Dirs::new();
    let input = json!({"script": SCRIPT, "args": args()});
    let out = launch(&dirs, RecordingGate::default(), focused(&dirs, "w-inline"), input).await;
    print_result("Q1 fallback, inline script with args", &out);
    ran_with_args(&out);
}

#[tokio::test]
async fn the_gate_can_run_a_routine_script_it_reads_itself() {
    let dirs = Dirs::new();
    let script = dirs.write("eos/routines/rt-1/scripts/rv-1.js", SCRIPT);
    let gate = RecordingGate::inlining_from(dirs.routines());
    let out = launch(&dirs, gate, focused(&dirs, "w-swap"), by_path(&script)).await;
    print_result("Q1 fallback, the gate swaps the routines path for the script it read", &out);
    ran_with_args(&out);
    assert_eq!(out.gate[0].input, by_path(&script), "the model asked by path");
}
