//! A team run: the lead starts its specialists where the blueprint says
//! they work, they report (a reader of outside text inside the untrusted
//! wrapper), the lead hands in its result, and it is checked and gated.

use std::path::{Path, PathBuf};
use std::process::Command;

use eos_contracts::{CheckOutcome, CheckVerdict, RoutineState, ToolScope};
use eos_core::capability::Checkout;
use eos_core::routine::{GateDecision, RunOrigin, StartError, SubmittedResult, Unready};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_testkit::FakeCapabilityReads;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

const REMOTE: &str = "https://github.com/acme/game.git";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// The user's clone of acme/game, whose remote is a local bare repository
/// holding pull request 1's head; and that head.
struct Repo {
    _dir: tempfile::TempDir,
    clone: PathBuf,
    sha: String,
}

fn repo() -> Repo {
    let dir = tempfile::tempdir().expect("a folder");
    let root = dir.path().canonicalize().expect("real");
    let (clone, bare, pr) = (root.join("game"), root.join("game.git"), root.join("pr"));
    for path in [&clone, &pr] {
        std::fs::create_dir_all(path).expect("a folder");
        git(path, &["init", "-q", "-b", "main"]);
        git(path, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    }
    git(&root, &["init", "-q", "--bare", "game.git"]);
    std::fs::write(pr.join("fix.txt"), "the fix\n").expect("a file");
    git(&pr, &["add", "-A"]);
    git(&pr, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fix"]);
    let sha = git(&pr, &["rev-parse", "HEAD"]);
    git(&pr, &["push", "-q", bare.to_str().expect("utf-8"), "HEAD:refs/pull/1/head"]);
    // github.com is never reached: the clone reads that address from the bare repository.
    git(&clone, &["config", &format!("url.{}.insteadOf", bare.display()), REMOTE]);
    Repo { _dir: dir, clone, sha }
}

fn reads(repo: &Repo) -> FakeCapabilityReads {
    let checkout = Checkout { remote: REMOTE.into(), refspec: "pull/1/head".into(), sha: repo.sha.clone() };
    FakeCapabilityReads::new().checkout_of("github:pr:acme/game#1", checkout)
}

/// PR Review as a team: the editor leads in its worktree; the tester shares
/// it and reads outside text; the reader reads the repository; the noter
/// works in a scratch folder.
fn team_blueprint() -> Value {
    let agent = |key: &str, lead: bool, workspace: &str, reads_outside: bool| {
        json!({"key": key, "name": key.to_uppercase(), "lead": lead, "brief": format!("{key} brief."),
               "model": "sonnet", "effort": "medium", "tools": {}, "readsOutside": reads_outside,
               "workspace": workspace})
    };
    let mut blueprint = blueprint(1);
    blueprint["who"]["depth"] = json!("team");
    blueprint["who"]["agents"] = json!([
        agent("editor", true, "worktree", false),
        agent("tester", false, "shared", true),
        agent("reader", false, "read", false),
        agent("noter", false, "none", false),
    ]);
    blueprint
}

fn specialist(bench: &Bench, worker: &str) -> eos_core::agent::LaunchSpec {
    bench.agents.started().into_iter().find(|s| s.worker_id == worker).expect("started")
}

fn worker_of(bench: &Bench, run: &str, agent: &str) -> String {
    let id = run.to_owned();
    let sessions = bench.temp.store.read_blocking(move |tx| tx.routine_sessions().by_run(&id)).expect("reads");
    sessions.into_iter().find(|s| s.agent_key.as_deref() == Some(agent)).expect("a session").worker_id
}

fn verdict(pass: bool) -> CheckVerdict {
    CheckVerdict {
        pass,
        checks: vec![CheckOutcome { key: "tests".into(), ok: pass, note: "n".into() }],
        must_fix: if pass { vec![] } else { vec!["Name the failing test.".into()] },
    }
}

fn review() -> SubmittedResult {
    SubmittedResult { kind: "github.review".into(), headline: "R".into(), body: json!({"summary": "s"}), files: vec![] }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lead_runs_its_team_where_the_blueprint_says_and_its_result_is_checked_and_gated() {
    let repo = repo();
    let bench = Bench::with_reads(true, reads(&repo));
    bench.keys.clone_at("git:github.com/acme/game", &repo.clone.to_string_lossy());
    let routine = bench.routine(RoutineState::Active, team_blueprint());
    let run =
        bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(1)))).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");

    // The lead works in its own worktree at the pull request's head, fetched into the clone.
    let lead_spec = specialist(&bench, &lead);
    assert_eq!(lead_spec.worker_definition.as_deref(), Some("eos-run-lead"));
    let made = bench.worktrees.created.lock().expect("created").clone();
    assert_eq!(made.len(), 1);
    assert_eq!(
        (made[0].branch.clone(), made[0].start_point.clone()),
        (format!("eos/run/{run}/editor"), Some(repo.sha.clone()))
    );
    assert_eq!(made[0].repo_root, repo.clone);
    git(&repo.clone, &["cat-file", "-e", &repo.sha]);
    let worktree = repo.clone.join(format!(".eos/worktrees/eos/run/{run}/editor")).to_string_lossy().into_owned();
    // The pull request is outside text: the session works in an empty folder, the worktree beside it.
    assert_eq!(lead_spec.additional_dirs, std::slice::from_ref(&worktree));
    let brief = lead_spec.prompt.expect("a brief");
    assert!(brief.contains("- tester (TESTER): tester brief.") && brief.contains(&worktree), "{brief}");

    let tools = bench.module.tools();
    for (agent, task) in [("tester", "Run the tests."), ("reader", "Read the diff."), ("noter", "Take notes.")] {
        tools.start_specialist(&lead, agent, task).await.expect("starts");
    }
    assert!(tools.start_specialist(&lead, "tester", "Again.").await.is_err(), "one session per specialist");
    assert!(tools.start_specialist(&lead, "editor", "Me.").await.is_err(), "the lead is no specialist");
    let (tester, reader, noter) =
        (worker_of(&bench, &run, "tester"), worker_of(&bench, &run, "reader"), worker_of(&bench, &run, "noter"));

    let tester_spec = specialist(&bench, &tester);
    assert_eq!(tester_spec.worker_definition.as_deref(), Some("eos-run-specialist"));
    assert_eq!(tester_spec.parent_id.as_deref(), Some(lead.as_str()));
    assert_eq!(tester_spec.additional_dirs, std::slice::from_ref(&worktree), "it shares the lead's worktree");
    let task = tester_spec.prompt.expect("a boot prompt");
    assert!(task.contains("tester brief.") && task.contains("Run the tests.") && task.contains("<untrusted"), "{task}");
    let clone = repo.clone.to_string_lossy().into_owned();
    assert_eq!(specialist(&bench, &reader).additional_dirs, std::slice::from_ref(&clone), "the reader reads the clone");
    let id = reader.clone();
    let row = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads").expect("a row");
    let scope: ToolScope = serde_json::from_str(row.tool_scope.as_deref().expect("a scope")).expect("json");
    assert!(scope.deny.iter().any(|tool| tool == "Edit"), "and edits nothing: {scope:?}");
    assert_eq!(specialist(&bench, &noter).additional_dirs, [format!("/scratch/{noter}")]);
    assert_eq!(bench.worktrees.created.lock().expect("created").len(), 1, "only the lead's worktree is made");

    // Their reports reach the lead; the tester reads outside text, so its report is marked.
    bench.agents.settled().await;
    bench.sessions.report(&tester, "result: SECRET-OUTSIDE all pass").await.expect("reported");
    bench.sessions.report(&reader, "result: the diff is small").await.expect("reported");
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|t| t.contains("SECRET-OUTSIDE"))).await;
    bench.eventually(|| bench.agents.sent(&lead).iter().any(|t| t.contains("the diff is small"))).await;
    let sent = bench.agents.sent(&lead);
    let tested = sent.iter().find(|t| t.contains("SECRET-OUTSIDE")).expect("the tester's report");
    assert!(tested.contains("<untrusted source=\"specialist:"), "{tested}");
    let read = sent.iter().find(|t| t.contains("the diff is small")).expect("the reader's report");
    assert!(!read.contains("<untrusted"), "{read}");
    let team = tools.list_specialists(&lead).await.expect("listed");
    let reports: Vec<(&str, Option<&str>)> =
        team.iter().map(|s| (s.agent.as_str(), s.last_report.as_deref())).collect();
    assert_eq!(
        reports,
        [
            ("tester", Some("result: SECRET-OUTSIDE all pass")),
            ("reader", Some("result: the diff is small")),
            ("noter", None)
        ]
    );
    tools.stop_specialist(&lead, "noter").await.expect("stopped");
    tools.message_specialist(&lead, "reader", "And the tests?").await.expect("sent");
    bench.eventually(|| bench.agents.sent(&reader).iter().any(|t| t.contains("And the tests?"))).await;

    // The result is checked: failed once, passed the second time, held at the gate.
    bench.gate.decide(GateDecision::Held { item_id: "ib-1".into() });
    for (round, pass) in [(1, false), (2, true)] {
        tools.submit_result(&lead, review()).await.expect("handed in");
        let checker = checker(&bench, round).await;
        tools.submit_verdict(&checker, verdict(pass)).await.expect("judged");
    }
    let held = bench.run(&run);
    assert_eq!((held.state, held.station), (RunState::WaitingForUser, Some(Station::Gate)));
}

async fn checker(bench: &Bench, n: usize) -> String {
    let is_checker = |s: &eos_core::agent::LaunchSpec| s.worker_definition.as_deref() == Some("eos-run-checker");
    bench.eventually(|| bench.agents.started().iter().filter(|s| is_checker(s)).count() >= n).await;
    bench.agents.started().iter().filter(|s| is_checker(s)).nth(n - 1).map(|s| s.worker_id.clone()).expect("one")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_whose_repository_has_no_local_clone_is_refused_before_any_run() {
    let repo = repo();
    let bench = Bench::with_reads(true, reads(&repo));
    let routine = bench.routine(RoutineState::Active, team_blueprint());
    let refused = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(1)))).await;
    assert_eq!(refused, Err(StartError::Unready(Unready::NoLocalClone { repo: Some("github.com/acme/game".into()) })));
    let id = routine.clone();
    let runs = bench.temp.store.read_blocking(move |tx| tx.runs().by_routine(&id, 10)).expect("reads");
    assert!(runs.is_empty(), "nothing was queued");
}

#[tokio::test(flavor = "multi_thread")]
async fn specialists_sharing_a_scratch_lead_need_no_clone_to_start() {
    let mut scratch = team_blueprint();
    scratch["who"]["agents"][0]["workspace"] = json!("none");
    scratch["who"]["agents"][2]["workspace"] = json!("none");
    let repo = repo();
    let bench = Bench::with_reads(true, reads(&repo));
    let routine = bench.routine(RoutineState::Active, scratch);
    let started = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(1)))).await;
    assert!(started.is_ok(), "the tester shares the lead's scratch folder: {started:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_whose_clone_went_after_its_start_fails_as_invalid() {
    let repo = repo();
    let bench = Bench::with_reads(true, reads(&repo));
    let routine = bench.routine(RoutineState::Active, team_blueprint());
    bench.keys.clone_at("git:github.com/acme/game", repo.clone.to_str().expect("utf-8"));
    let run =
        bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(1)))).await.expect("starts").remove(0).id;
    bench.keys.forget("git:github.com/acme/game");
    bench.supervise().await;
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    let failed = bench.run(&run);
    assert_eq!((failed.reason, failed.station), (Some(Reason::Invalid), Some(Station::Brief)));
    let id = run.clone();
    let events = bench.temp.store.read_blocking(move |tx| tx.runs().events(&id)).expect("reads");
    assert!(events.iter().any(|e| e.kind == "no_local_clone"));
    assert!(bench.agents.started().is_empty(), "nothing started");
}
