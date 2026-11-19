//! How a run's sessions start: in `AcceptEdits` under the run scope, without
//! the folder's MCP servers, and, when the run reads outside text, in its
//! own empty folder with the workspace as a further root, also after a
//! resume and a restart. And what capability actions they may call.

use eos_contracts::{ActionClass, RoutineState, ToolScope};
use eos_core::capability::{Capability, GrantedAction};
use eos_core::routine::RunOrigin;
use eos_domain::capability::health::Health;
use eos_domain::routine::run::{RunState, Station};
use eos_domain::run_scope::{RunRole, Trust, scope_for};
use eos_runtime::module::Module;
use eos_testkit::FakeCapabilityReads;
use serde_json::json;

use crate::bench::{Bench, blueprint, new_run, pull_request};

const GITHUB: &str = r#"
id = "github"
name = "GitHub"
version = "1"
summary = "Pull requests and reviews on GitHub."
form = "builtin"
works = "any_mac"

[[actions]]
name = "get_pull_request"
summary = "Read a pull request."
class = "read"

[[actions]]
name = "save_draft"
summary = "Keep a draft on this Mac."
class = "write_local"

[[actions]]
name = "post_review"
summary = "Post a review."
class = "speak"
recipient = "input:/pull"
input = { type = "object", properties = { pull = { type = "string" } } }
"#;

fn github() -> Capability {
    let manifest = eos_domain::capability::manifest::parse(GITHUB).expect("a manifest");
    Capability {
        id: manifest.id.clone(),
        origin: "builtin".into(),
        version: None,
        manifest,
        health: Health::ready(),
        settings: json!({}),
        account_label: None,
    }
}

/// Starts a run of `item` and waits until its lead works. The supervisor
/// starts once per test.
async fn lead_of(bench: &Bench, routine: &str, untrusted: bool) -> (String, String) {
    let mut item = pull_request(1);
    item.untrusted = untrusted;
    let id = bench.start(new_run(routine, RunOrigin::Hand, Some(item))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&id).station == Some(Station::Work)).await;
    (id.clone(), bench.run(&id).lead_id.expect("a lead"))
}

fn scope(trust: Trust, folder: &str) -> ToolScope {
    scope_for(RunRole::Solo, trust, &["call_capability"], None, folder)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trusted_runs_lead_works_in_its_folder_in_accept_edits_under_the_run_scope() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let (_, lead) = lead_of(&bench, &routine, false).await;

    let spec = &bench.agents.started()[0];
    let folder = format!("/scratch/{lead}");
    assert_eq!((spec.cwd.as_str(), spec.additional_dirs.as_slice()), (folder.as_str(), &[][..]));
    assert!(!spec.folder_mcp, "no server of the folder's own");
    let id = lead.clone();
    let row = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    assert_eq!(row.permission_mode.as_deref(), Some("acceptEdits"));
    let stored: ToolScope = serde_json::from_str(row.tool_scope.as_deref().expect("a scope")).expect("a scope");
    assert_eq!(stored, scope(Trust::Trusted, &folder));
    assert!(!stored.allow.iter().any(|tool| tool == "Workflow"), "Workflow is in no run scope");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_untrusted_runs_lead_works_in_an_empty_folder_with_its_workspace_beside_also_after_a_resume() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let (run, lead) = lead_of(&bench, &routine, true).await;

    let work = bench.temp.home.path().join(format!("routines/{routine}/runs/{run}/work"));
    let folder = format!("/scratch/{lead}");
    let spec = &bench.agents.started()[0];
    assert_eq!(spec.cwd, work.to_string_lossy());
    assert_eq!(spec.additional_dirs, std::slice::from_ref(&folder));
    assert!(!spec.folder_mcp);
    assert!(work.is_dir() && std::fs::read_dir(&work).expect("a folder").next().is_none(), "made, and empty");
    let brief = spec.prompt.clone().expect("a brief");
    assert!(brief.contains(&folder), "the brief names the folder to work in: {brief}");
    let id = lead.clone();
    let row = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    let stored: ToolScope = serde_json::from_str(row.tool_scope.as_deref().expect("a scope")).expect("a scope");
    assert_eq!(stored, scope(Trust::Untrusted, &folder), "edits stay in the workspace");

    // Its session dies and is resumed: the same start, the folder made again.
    std::fs::remove_dir(&work).expect("removed");
    bench.agents.settled().await;
    bench.agents.crash(&lead).await;
    bench.eventually(|| bench.agents.started().len() == 2).await;
    let resumed = &bench.agents.started()[1];
    assert!(resumed.resume.is_some());
    assert_eq!((resumed.cwd.as_str(), resumed.additional_dirs.clone()), (spec.cwd.as_str(), vec![folder.clone()]));
    assert!(!resumed.folder_mcp && work.is_dir());

    // After a restart, the module reads its run sessions again before any resume.
    let restarted = bench.another_module();
    restarted.after_ready().await.expect("starts");
    let mut again = eos_core::agent::LaunchSpec::new(&lead, &folder, "sonnet");
    restarted.shape_launch(&mut again);
    assert_eq!(
        (again.cwd.as_str(), again.additional_dirs.as_slice(), again.folder_mcp),
        (spec.cwd.as_str(), &[folder.clone()][..], false)
    );
    let mut chat = eos_core::agent::LaunchSpec::new("w-chat", "/repo", "sonnet");
    restarted.shape_launch(&mut chat);
    assert_eq!((chat.cwd.as_str(), chat.folder_mcp), ("/repo", true), "a chat starts as it always did");
    restarted.stop().await;
    assert_eq!(bench.state(&run), RunState::Running);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_session_may_call_the_read_and_local_actions_of_what_its_version_needs() {
    let bench = Bench::with_reads(true, FakeCapabilityReads::new().listing(github()));
    let mut needs = blueprint(1);
    needs["needs"] = json!(["github"]);
    let routine = bench.routine(RoutineState::Active, needs.clone());
    // An agent that reads outside text only reads.
    needs["who"]["agents"][0]["readsOutside"] = json!(true);
    let outside = bench.routine(RoutineState::Active, needs);
    let reading = bench.hand(&outside, Some(pull_request(2))).await;
    let (_, lead) = lead_of(&bench, &routine, true).await;
    bench.eventually(|| bench.run(&reading).station == Some(Station::Work)).await;
    let reader = bench.run(&reading).lead_id.expect("a lead");
    let grants = bench.module.grants();

    let grant = grants.grant(&lead).await.expect("a run session has a grant");
    let granted = |name: &str| GrantedAction { capability: "github".into(), action: name.into() };
    assert_eq!(grant.actions, [granted("get_pull_request"), granted("save_draft")]);
    assert_eq!(grant.max_class, ActionClass::WriteLocal);
    assert_eq!(grants.grant("w-chat").await, None, "a chat calls what is installed");

    let grant = grants.grant(&reader).await.expect("a grant");
    assert_eq!((grant.actions, grant.max_class), (vec![granted("get_pull_request")], ActionClass::Read));
}
