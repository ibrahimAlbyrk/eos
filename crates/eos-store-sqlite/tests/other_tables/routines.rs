//! The routine and run tables: each written and read back, the slug and
//! trigger locks, and the bound on a run's timeline.

use eos_contracts::{DraftStatus, RoutineKind, RoutineState, VersionAuthor, VersionStatus};
use eos_core::store::{
    RUN_EVENTS_MAX, RUN_STATE_EVENT, RunCounts, StoredDraft, StoredRoutine, StoredRoutineSession, StoredRun,
    StoredRunResult, StoredVersion,
};
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::Trust;
use eos_testkit::TempStore;

fn routine(id: &str, slug: &str, state: RoutineState) -> StoredRoutine {
    StoredRoutine {
        id: id.into(),
        slug: slug.into(),
        name: "PR Review".into(),
        kind: RoutineKind::Standing,
        state,
        paused_reason: None,
        head_version_id: None,
        origin: "hand".into(),
        task_key: None,
        agents_may_start: false,
        failure_streak: 0,
        created_at: 10,
        updated_at: 10,
        changed_at: 10,
        started_at: None,
        deleted_at: None,
    }
}

fn version(id: &str, routine_id: &str, created_at: i64) -> StoredVersion {
    StoredVersion {
        id: id.into(),
        routine_id: routine_id.into(),
        parent_id: None,
        status: VersionStatus::Kept,
        author: VersionAuthor::User,
        note: None,
        format: 1,
        blueprint: r#"{"format":1}"#.into(),
        hash: "ab".into(),
        no_trial: false,
        trust: Trust::Trusted,
        device: None,
        created_at,
    }
}

fn run(id: &str, routine_id: &str, origin: &str, origin_ref: Option<&str>, created_at: i64) -> StoredRun {
    StoredRun {
        id: id.into(),
        routine_id: routine_id.into(),
        version_id: None,
        kind: "standing".into(),
        origin: origin.into(),
        origin_ref: origin_ref.map(Into::into),
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
    }
}

#[test]
fn a_routine_its_versions_draft_sessions_and_spend_read_back_as_written() {
    let temp = TempStore::new();
    let mut paused = routine("rt-1", "pr-review", RoutineState::Paused);
    paused.paused_reason = Some("failures".into());
    paused.head_version_id = Some("rv-2".into());
    paused.agents_may_start = true;
    let mut second = version("rv-2", "rt-1", 30);
    second.parent_id = Some("rv-1".into());
    second.author = VersionAuthor::Architect;
    second.note = Some("deeper checks".into());
    second.trust = Trust::Untrusted;
    second.no_trial = true;
    let draft = StoredDraft {
        routine_id: "rt-1".into(),
        purpose: "change".into(),
        architect_id: Some("w-arch".into()),
        base_version_id: Some("rv-2".into()),
        draft_version_id: None,
        question: None,
        status: DraftStatus::Asking,
        created_at: 40,
        updated_at: 41,
    };
    let session = |worker_id: &str, run_id: Option<&str>, role: &str| StoredRoutineSession {
        worker_id: worker_id.into(),
        routine_id: "rt-1".into(),
        run_id: run_id.map(Into::into),
        role: role.into(),
        agent_key: None,
        created_at: 50,
    };
    let (stored, (head, written), listed, draft_back, sessions, spend) = {
        let (paused, second, draft) = (paused.clone(), second.clone(), draft.clone());
        temp.store
            .write_blocking(move |tx, _| {
                tx.routines().insert(&paused)?;
                tx.routines().insert(&routine("rt-2", "digest", RoutineState::Active))?;
                tx.routines().insert_draft(&draft)?;
                let versions = tx.routine_versions();
                versions.insert(&second)?;
                versions.insert(&version("rv-1", "rt-1", 20))?;
                versions.insert(&version("rv-3", "rt-1", 30))?;
                versions.insert(&version("rv-9", "rt-2", 5))?;
                let sessions = tx.routine_sessions();
                sessions.insert(&session("w-arch", None, "architect"))?;
                sessions.insert(&session("w-lead", Some("rn-1"), "lead"))?;
                sessions.insert(&session("w-check", Some("rn-1"), "checker"))?;
                let spend = tx.routine_spend();
                spend.add("2026-11-18", "rt-1", "run", 0.5)?;
                spend.add("2026-11-18", "rt-1", "run", 0.25)?;
                spend.add("2026-11-18", "rt-1", "architect", 0.1)?;
                spend.add("2026-11-19", "rt-1", "run", 9.0)?;
                Ok((
                    tx.routines().find("rt-1")?,
                    (versions.head("rt-1")?, versions.find("rt-1", "rv-2")?),
                    versions.list("rt-1")?,
                    tx.routines().draft("rt-1")?,
                    (sessions.find("w-lead")?, sessions.find("w-chat")?, sessions.by_run("rn-1")?),
                    spend.of_day("2026-11-18")?,
                ))
            })
            .expect("writes")
    };
    assert_eq!(stored, Some(paused));
    assert_eq!(head.as_ref(), Some(&second));
    assert_eq!(written, Some(second));
    let order: Vec<&str> = listed.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(order, ["rv-1", "rv-2", "rv-3"], "by time made, then by when it was written");
    assert_eq!(draft_back, Some(draft));
    let (lead, chat, by_run) = sessions;
    assert_eq!(lead.map(|s| s.role), Some("lead".into()));
    assert_eq!(chat, None, "a chat is no routine session");
    assert_eq!(by_run.iter().map(|s| s.worker_id.as_str()).collect::<Vec<_>>(), ["w-lead", "w-check"]);
    let booked: Vec<(&str, f64, i64)> = spend.iter().map(|s| (s.kind.as_str(), s.cost_usd, s.count)).collect();
    assert_eq!(booked, [("architect", 0.1, 1), ("run", 0.75, 2)]);

    let all = temp.store.read_blocking(|tx| tx.routines().list()).expect("reads");
    assert_eq!(all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["rt-1", "rt-2"]);
    let none = temp
        .store
        .read_blocking(|tx| Ok((tx.routines().find("rt-x")?, tx.routine_versions().find("rt-2", "rv-1")?)))
        .expect("reads");
    assert_eq!(none, (None, None), "a version is found only under its own routine");

    temp.exec(
        "INSERT INTO routine_suggestions (key, state, inbox_id, created_at) VALUES ('daily-notes', 'open', NULL, 1)",
    );
    assert_eq!(temp.count("SELECT COUNT(*) FROM routine_suggestions WHERE state = 'open'"), 1);
}

#[test]
fn runs_and_their_results_read_back_newest_first_with_their_counts() {
    let temp = TempStore::new();
    let mut done = run("rn-1", "rt-1", "hand", None, 100);
    done.state = RunState::Done;
    done.station = Some(Station::Deliver);
    done.outcome = Some(Outcome::SentEdited);
    done.headline = Some("Three comments".into());
    done.cost_usd = 0.42;
    done.work_ms = 61_000;
    done.ended_at = Some(400);
    let mut failed = run("rn-2", "rt-1", "trigger", Some("sig-1"), 200);
    failed.state = RunState::Failed;
    failed.reason = Some(Reason::BudgetTime);
    let mut waiting = run("rn-3", "rt-1", "hand", None, 300);
    waiting.state = RunState::WaitingForUser;
    let result = |attempt: i64| StoredRunResult {
        run_id: "rn-1".into(),
        attempt,
        kind: "github.review".into(),
        headline: format!("Round {attempt}"),
        body: "{}".into(),
        files: None,
        verdict: Some(r#"{"pass":true}"#.into()),
        created_at: 300 + attempt,
    };
    let (found, newest, two, counts, results) = {
        let done = done.clone();
        temp.store
            .write_blocking(move |tx, _| {
                let runs = tx.runs();
                runs.insert(&done)?;
                runs.insert(&failed)?;
                runs.insert(&waiting)?;
                runs.insert(&run("rn-4", "rt-1", "hand", None, 50))?;
                runs.insert(&run("rn-5", "rt-2", "hand", None, 500))?;
                tx.run_results().insert(&result(2))?;
                tx.run_results().insert(&result(1))?;
                Ok((
                    runs.find("rn-1")?,
                    runs.by_routine("rt-1", 20)?,
                    runs.by_routine("rt-1", 2)?,
                    (runs.counts("rt-1", 100)?, runs.counts("rt-none", 0)?),
                    tx.run_results().by_run("rn-1")?,
                ))
            })
            .expect("writes")
    };
    assert_eq!(found, Some(done));
    let ids = |runs: &[StoredRun]| runs.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&newest), ["rn-3", "rn-2", "rn-1", "rn-4"]);
    assert_eq!(newest[1].reason, Some(Reason::BudgetTime));
    assert_eq!(ids(&two), ["rn-3", "rn-2"]);
    assert_eq!(counts, (RunCounts { since: 3, live: 2 }, RunCounts { since: 0, live: 0 }), "queued and waiting live");
    assert_eq!(results.iter().map(|r| r.headline.as_str()).collect::<Vec<_>>(), ["Round 1", "Round 2"]);
}

#[test]
fn a_live_slug_names_one_routine_and_a_deleted_or_one_off_lets_go_of_it() {
    let temp = TempStore::new();
    let insert = |routine: StoredRoutine| temp.store.write_blocking(move |tx, _| tx.routines().insert(&routine));
    insert(routine("rt-1", "pr-review", RoutineState::Active)).expect("the first");
    assert!(insert(routine("rt-2", "pr-review", RoutineState::Paused)).is_err(), "a second live one is refused");
    insert(routine("rt-3", "pr-review", RoutineState::Deleted)).expect("a deleted one may share it");
    insert(routine("rt-4", "pr-review", RoutineState::Transient)).expect("so may a one-off");
    insert(routine("rt-5", "digest", RoutineState::Draft)).expect("another slug");
    assert_eq!(temp.count("SELECT COUNT(*) FROM routines"), 4);
}

#[test]
fn a_signal_starts_one_run_of_a_routine_however_often_it_matches() {
    let temp = TempStore::new();
    let insert = |run: StoredRun| temp.store.write_blocking(move |tx, _| tx.runs().insert(&run));
    insert(run("rn-1", "rt-1", "trigger", Some("sig-1"), 1)).expect("the first");
    assert!(insert(run("rn-2", "rt-1", "trigger", Some("sig-1"), 2)).is_err(), "the second is refused");
    insert(run("rn-3", "rt-2", "trigger", Some("sig-1"), 3)).expect("another routine's run for the signal");
    insert(run("rn-4", "rt-1", "trigger", Some("sig-2"), 4)).expect("the next signal");
    insert(run("rn-5", "rt-1", "again", Some("sig-1"), 5)).expect("a run by hand again is no trigger run");
    assert_eq!(temp.count("SELECT COUNT(*) FROM runs"), 4);
}

#[test]
fn a_runs_timeline_drops_its_oldest_events_past_the_bound_but_never_a_state_change() {
    let temp = TempStore::new();
    let events = temp
        .store
        .write_blocking(|tx, _| {
            let runs = tx.runs();
            runs.append_event("rn-1", 1, RUN_STATE_EVENT, Some(r#"{"state":"running"}"#))?;
            for at in 2..=(RUN_EVENTS_MAX + 5) {
                runs.append_event("rn-1", at, "activity", Some(r#"{"count":1}"#))?;
            }
            runs.append_event("rn-2", 1, "activity", None)?;
            Ok((runs.events("rn-1")?, runs.events("rn-2")?))
        })
        .expect("writes");
    let (kept, other) = events;
    assert_eq!(kept.len() as i64, RUN_EVENTS_MAX);
    assert_eq!((kept[0].kind.as_str(), kept[0].at), (RUN_STATE_EVENT, 1), "the state change stays");
    assert_eq!(kept[1].at, 7, "the five oldest activities went");
    assert_eq!(kept.last().map(|e| e.at), Some(RUN_EVENTS_MAX + 5));
    assert_eq!(other.len(), 1, "another run's timeline is its own");
}
