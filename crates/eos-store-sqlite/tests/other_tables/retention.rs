//! Clearing old routine history: which runs are past what a routine keeps,
//! what a deleted run takes with it, whose transcripts are due, and which
//! routines leave for good with every row of theirs.

use eos_contracts::{DraftStatus, NameSource, RoutineState};
use eos_core::store::{EndedRun, Leaving, NewWorker, RunMove, StoredDraft, StoredRoutineSession, StoredRunResult, Tx};
use eos_domain::routine::numbers::WEEK_MS;
use eos_domain::routine::run::RunState;
use eos_testkit::TempStore;

use super::inbox::{delivery, outcome};
use super::routines::{routine, run};

fn ended(tx: &dyn Tx, id: &str, routine_id: &str, created_at: i64, ended_at: i64) -> Result<(), eos_core::Error> {
    tx.runs().insert(&run(id, routine_id, "hand", None, created_at))?;
    let at = ended_at;
    tx.runs().move_to(id, &RunMove { state: RunState::Done, station: None, reason: None, at })?;
    Ok(())
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

fn session(worker_id: &str, routine_id: &str, run_id: Option<&str>) -> StoredRoutineSession {
    StoredRoutineSession {
        worker_id: worker_id.into(),
        routine_id: routine_id.into(),
        run_id: run_id.map(Into::into),
        role: "solo".into(),
        agent_key: None,
        created_at: 1,
    }
}

#[test]
fn runs_past_the_newest_and_old_enough_go_with_what_hangs_on_them_but_not_the_first_week() {
    let temp = TempStore::new();
    let started = 1_000;
    let (past, deleted, rows_left, outcomes_left, transcripts) = temp
        .store
        .write_blocking(move |tx, _| {
            let mut rt = routine("rt-1", "pr-review", RoutineState::Active);
            rt.started_at = Some(started);
            tx.routines().insert(&rt)?;
            // rn-1 and rn-2 are old; rn-3 ended late; rn-4 and rn-5 are the newest two.
            ended(tx, "rn-1", "rt-1", 100, 200)?;
            ended(tx, "rn-2", "rt-1", 110, 300)?;
            ended(tx, "rn-3", "rt-1", 120, 9_000)?;
            tx.runs().insert(&run("rn-0", "rt-1", "hand", None, 90))?;
            let waiting = RunMove { state: RunState::WaitingForUser, station: None, reason: None, at: 95 };
            tx.runs().move_to("rn-0", &waiting)?;
            ended(tx, "rn-4", "rt-1", 130, 400)?;
            ended(tx, "rn-5", "rt-1", 140, 500)?;
            let past = tx.routine_retention().runs_past(2, 1_000, None, 10)?;
            let next = tx.routine_retention().runs_past(2, 1_000, Some((200, "rn-1")), 10)?;
            assert_eq!(next.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["rn-2"], "a page starts after its key");

            tx.run_results().insert(&StoredRunResult {
                run_id: "rn-1".into(),
                attempt: 1,
                kind: "review".into(),
                headline: "h".into(),
                body: "b".into(),
                files: None,
                verdict: None,
                created_at: 150,
            })?;
            tx.routine_sessions().insert(&session("w-1", "rt-1", Some("rn-1")))?;
            tx.routine_sessions().insert(&session("w-3", "rt-1", Some("rn-3")))?;
            tx.workers().insert(&worker("w-1"))?;
            tx.workers().insert(&worker("w-3"))?;
            tx.inbox_deliveries().insert(&delivery("dl-1", "sent", None, 160))?;
            let mut first_week = outcome("rt-1", "sent_unedited", started + 10);
            first_week.run_id = "rn-1".into();
            let mut later = outcome("rt-1", "sent_edited", started + WEEK_MS);
            later.run_id = "rn-1".into();
            tx.inbox_outcomes().insert(&first_week)?;
            tx.inbox_outcomes().insert(&later)?;
            let transcripts = tx.routine_retention().transcripts_past(500, "", 10)?;

            let deleted = tx.routine_retention().delete_runs(&["rn-1".to_owned()])?;
            let rows_left = (
                tx.runs().find("rn-1")?.is_some(),
                tx.runs().events("rn-1")?.len(),
                tx.run_results().by_run("rn-1")?.len(),
                tx.routine_sessions().by_run("rn-1")?.len(),
                tx.inbox_deliveries().find("dl-1")?.is_some(),
            );
            let outcomes_left = tx.inbox_outcomes().by_routine("rt-1", 10)?;
            Ok((past, deleted, rows_left, outcomes_left, transcripts))
        })
        .expect("writes");
    let ids: Vec<&str> = past.iter().map(|r: &EndedRun| r.id.as_str()).collect();
    assert_eq!(ids, ["rn-1", "rn-2"], "neither the newest two, a late end nor a run waiting for the user");
    assert_eq!(transcripts, ["w-1"], "only the sessions of runs that ended in time");
    assert_eq!(deleted, 1);
    assert_eq!(rows_left, (false, 0, 0, 0, false));
    let outcomes: Vec<&str> = outcomes_left.iter().map(|o| o.outcome.outcome.as_str()).collect();
    assert_eq!(outcomes, ["sent_unedited"], "the first week's outcome stays as the baseline");
}

#[test]
fn routines_leave_once_deleted_long_enough_a_one_off_ran_or_a_draft_was_left_and_take_every_row() {
    let temp = TempStore::new();
    let (leaving, workers, left) = temp
        .store
        .write_blocking(|tx, _| {
            let mut gone = routine("rt-1", "gone", RoutineState::Deleted);
            gone.deleted_at = Some(100);
            let mut fresh = routine("rt-2", "fresh", RoutineState::Deleted);
            fresh.deleted_at = Some(5_000);
            let mut busy = routine("rt-3", "busy", RoutineState::Deleted);
            busy.deleted_at = Some(100);
            for routine in [gone, fresh, busy] {
                tx.routines().insert(&routine)?;
            }
            tx.routines().insert(&routine("rt-4", "once", RoutineState::Transient))?;
            tx.routines().insert(&routine("rt-5", "left", RoutineState::Draft))?;
            tx.routines().insert(&routine("rt-6", "working", RoutineState::Draft))?;
            let draft = |id: &str, status: DraftStatus| StoredDraft {
                routine_id: id.into(),
                purpose: "new".into(),
                architect_id: None,
                base_version_id: None,
                draft_version_id: None,
                question: None,
                status,
                created_at: 10,
                updated_at: 200,
            };
            tx.routines().insert_draft(&draft("rt-5", DraftStatus::Abandoned))?;
            tx.routines().insert_draft(&draft("rt-6", DraftStatus::Working))?;
            ended(tx, "rn-1", "rt-1", 10, 50)?;
            tx.runs().insert(&run("rn-3", "rt-3", "hand", None, 10))?;
            ended(tx, "rn-4", "rt-4", 10, 300)?;
            tx.routine_sessions().insert(&session("w-1", "rt-1", Some("rn-1")))?;
            tx.routine_sessions().insert(&session("w-arch", "rt-1", None))?;
            tx.workers().insert(&worker("w-arch"))?;
            tx.inbox_outcomes().insert(&outcome("rt-1", "sent_unedited", 20))?;
            tx.routine_spend().add("2027-01-01", "rt-1", "run", 0.5)?;

            let when = Leaving { deleted_by: 1_000, once_by: 1_000, draft_by: 1_000 };
            let leaving = tx.routine_retention().leaving(&when, "", 10)?;
            let workers = tx.routine_retention().workers_of("rt-1")?;
            assert_eq!(tx.routine_retention().delete_runs_of("rt-1", 10)?, 1);
            tx.routine_retention().delete_routine("rt-1")?;
            let left = (
                tx.routines().find("rt-1")?.is_some(),
                tx.runs().find("rn-1")?.is_some(),
                tx.routine_sessions().find("w-arch")?.is_some(),
                tx.inbox_outcomes().by_routine("rt-1", 10)?.len(),
                tx.routine_spend().total("rt-1", "run")?,
            );
            Ok((leaving, workers, left))
        })
        .expect("writes");
    let ids: Vec<(&str, RoutineState)> = leaving.iter().map(|r| (r.id.as_str(), r.state)).collect();
    assert_eq!(
        ids,
        [("rt-1", RoutineState::Deleted), ("rt-4", RoutineState::Transient), ("rt-5", RoutineState::Draft)],
        "not one deleted lately, one with a run that has not ended, or a draft still worked on"
    );
    assert_eq!(workers, ["w-arch"], "only workers still there");
    assert_eq!(left, (false, false, false, 0, 0.0));
}
