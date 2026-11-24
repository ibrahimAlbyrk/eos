//! What routines keep: at start the pass drops a run past the newest 500
//! and 90 days but keeps one waiting for the user and the first week's
//! outcomes, purges the transcripts of a run 15 days ended while its result
//! stays, and lets a routine deleted 31 days ago leave with one export in
//! the trash.

use eos_contracts::{NameSource, RoutineKind, RoutineState, VersionAuthor, VersionStatus};
use eos_core::Clock;
use eos_core::store::{
    NewOutcome, NewWorker, RunMove, StoredRoutine, StoredRoutineSession, StoredRun, StoredRunResult, StoredVersion, Tx,
};
use eos_domain::routine::run::RunState;
use eos_domain::run_scope::Trust;
use eos_runtime::module::Module;
use serde_json::Value;

use crate::bench::Bench;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn routine(id: &str, state: RoutineState, started_at: Option<i64>, deleted_at: Option<i64>) -> StoredRoutine {
    StoredRoutine {
        id: id.into(),
        slug: id.into(),
        name: "PR Review".into(),
        kind: RoutineKind::Standing,
        state,
        paused_reason: None,
        head_version_id: Some(format!("rv-{id}")),
        origin: "hand".into(),
        task_key: None,
        agents_may_start: false,
        failure_streak: 0,
        created_at: 1,
        updated_at: 1,
        changed_at: 1,
        started_at,
        deleted_at,
    }
}

fn version(routine_id: &str) -> StoredVersion {
    StoredVersion {
        id: format!("rv-{routine_id}"),
        routine_id: routine_id.into(),
        parent_id: None,
        status: VersionStatus::Kept,
        author: VersionAuthor::User,
        note: None,
        format: 1,
        blueprint: r#"{"format":1,"name":"PR Review"}"#.into(),
        hash: "h".into(),
        no_trial: false,
        trust: Trust::Trusted,
        device: None,
        created_at: 1,
    }
}

/// A run made at `created_at`, ended at `ended_at` unless it waits for the user.
fn run(tx: &dyn Tx, id: &str, routine_id: &str, created_at: i64, ended_at: Option<i64>) -> Result<(), eos_core::Error> {
    tx.runs().insert(&StoredRun {
        id: id.into(),
        routine_id: routine_id.into(),
        version_id: Some(format!("rv-{routine_id}")),
        kind: "standing".into(),
        origin: "hand".into(),
        origin_ref: None,
        door: None,
        input: r#"{"result":"usual"}"#.into(),
        item_key: None,
        state: RunState::Queued,
        station: None,
        reason: None,
        attempt: 1,
        resumed: 0,
        not_before: None,
        priority: 0,
        progress_done: None,
        progress_total: None,
        headline: None,
        outcome: None,
        cost_usd: 0.0,
        work_ms: 0,
        lead_id: None,
        device: "mac-1".into(),
        remote: false,
        created_at,
        started_at: None,
        ended_at: None,
        updated_at: created_at,
    })?;
    let (state, at) = match ended_at {
        Some(at) => (RunState::Done, at),
        None => (RunState::WaitingForUser, created_at),
    };
    tx.runs().move_to(id, &RunMove { state, station: None, reason: None, at }).map(drop)
}

fn worker(id: &str) -> NewWorker {
    NewWorker {
        id: id.into(),
        prompt: "Run.".into(),
        cwd: None,
        worktree_from: None,
        branch: None,
        name: None,
        name_source: NameSource::Default,
        pid: None,
        port: 0,
        started_at: 1,
        parent_id: None,
        model: "sonnet".into(),
        effort: None,
        is_orchestrator: false,
        backend_kind: "claude".into(),
        backend_profile: None,
        agent_role: Some("focused".into()),
        worker_definition: None,
        tool_scope: None,
        with_gateway: false,
        collaborate: false,
        worktree_dir: None,
        workspace_owner_id: None,
        workspace_ready: true,
        scratch: false,
    }
}

fn outcome(run_id: &str, outcome: &str, at: i64) -> NewOutcome {
    NewOutcome {
        routine_id: "rt-kept".into(),
        run_id: run_id.into(),
        item_id: None,
        delivery_id: None,
        outcome: outcome.into(),
        rung: "draft".into(),
        at,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn old_runs_transcripts_and_a_long_deleted_routine_go_and_what_must_stay_stays() {
    let bench = Bench::new(true);
    let now = bench.clock.now_ms();
    let started = now - 200 * DAY;
    bench
        .temp
        .store
        .write_blocking(move |tx, _| {
            tx.routines().insert(&routine("rt-kept", RoutineState::Active, Some(started), None))?;
            tx.routine_versions().insert(&version("rt-kept"))?;
            // The oldest two: one waiting for the user, one ended 100 days ago.
            run(tx, "rn-waiting", "rt-kept", started, None)?;
            run(tx, "rn-old", "rt-kept", started + 1, Some(now - 100 * DAY))?;
            for n in 0..500 {
                run(tx, &format!("rn-{n:03}"), "rt-kept", started + 10 + n, Some(now - 15 * DAY))?;
            }
            tx.inbox_outcomes().insert(&outcome("rn-old", "sent_unedited", started + DAY))?;
            tx.inbox_outcomes().insert(&outcome("rn-old", "sent_edited", started + 30 * DAY))?;
            tx.routine_sessions().insert(&StoredRoutineSession {
                worker_id: "w-lead".into(),
                routine_id: "rt-kept".into(),
                run_id: Some("rn-000".into()),
                role: "solo".into(),
                agent_key: Some("editor".into()),
                created_at: started,
            })?;
            tx.workers().insert(&worker("w-lead"))?;
            tx.run_results().insert(&StoredRunResult {
                run_id: "rn-000".into(),
                attempt: 1,
                kind: "github.review".into(),
                headline: "Looks fine".into(),
                body: "{}".into(),
                files: None,
                verdict: None,
                created_at: started,
            })?;

            tx.routines().insert(&routine("rt-gone", RoutineState::Deleted, Some(started), Some(now - 31 * DAY)))?;
            tx.routine_versions().insert(&version("rt-gone"))?;
            run(tx, "rn-gone", "rt-gone", started, Some(started + DAY))
        })
        .expect("writes");
    let home = bench.temp.home.path().to_owned();
    std::fs::create_dir_all(home.join("routines/rt-kept/runs/rn-old/files")).expect("a run folder");
    std::fs::create_dir_all(home.join("routines/rt-gone/runs/rn-gone")).expect("a run folder");

    bench.supervise().await;
    let gone =
        |id: &'static str| bench.temp.store.read_blocking(move |tx| tx.routines().find(id)).expect("reads").is_none();
    bench.eventually(|| gone("rt-gone") && bench.trash.trashed().len() == 3).await;

    let (old, waiting, result, outcomes, lead) = bench
        .temp
        .store
        .read_blocking(|tx| {
            Ok((
                tx.runs().find("rn-old")?.is_some(),
                tx.runs().find("rn-waiting")?.is_some(),
                tx.run_results().by_run("rn-000")?.len(),
                tx.inbox_outcomes().by_routine("rt-kept", 10)?,
                tx.workers().find("w-lead")?.is_some(),
            ))
        })
        .expect("reads");
    assert!(!old && waiting, "the 501st run goes, the one waiting for the user stays");
    assert_eq!(result, 1, "the purged run's result stays");
    assert!(!lead && bench.agents.forgotten().contains(&"w-lead".to_owned()), "its transcript is purged");
    let kept: Vec<&str> = outcomes.iter().map(|o| o.outcome.outcome.as_str()).collect();
    assert_eq!(kept, ["sent_unedited"], "the first week's outcome stays");
    assert!(bench.state("rn-000") == RunState::Done, "a run within 90 days stays");

    let trashed = bench.trash.trashed();
    assert!(trashed.contains(&home.join("routines/rt-kept/runs/rn-old")), "{trashed:?}");
    assert!(trashed.contains(&home.join("routines/rt-gone")), "{trashed:?}");
    let at = trashed.iter().position(|p| p.ends_with("PR Review (Eos routine).json")).expect("one export");
    let export: Value =
        serde_json::from_slice(&std::fs::read(bench.trash.kept(at)).expect("the export")).expect("json");
    assert_eq!(
        (export["routine"]["id"].as_str(), export["versions"].as_array().map(Vec::len)),
        (Some("rt-gone"), Some(1))
    );
    assert_eq!(export["runs"][0]["id"], "rn-gone");
    assert!(bench.temp.store.read_blocking(|tx| tx.runs().find("rn-gone")).expect("reads").is_none());
    let removed = eos_testkit::FeedbackCall::RoutineRemoved("rt-gone".into());
    bench.eventually(|| bench.feedback.calls().contains(&removed)).await;
    let gone = eos_testkit::SurfaceCall::Remove("rt-gone".into());
    bench.eventually(|| bench.surfaces.calls().contains(&gone)).await;
    bench.module.stop().await;
}
