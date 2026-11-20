//! The check station (01 §4.9): a result the lead handed in is checked
//! before it goes anywhere, while the lead is held (messages to it queue).
//! First the rules: it is what the routine makes, its recipients are ones
//! the user confirmed, and its kind's validator takes it. Then, when the
//! routine says so, a checker session reads the routine's checks, the item
//! and the result and gives its verdict. A fail sends the lead back to work
//! once with what must change; a second fails the run as `check_failed`. A
//! checker that dies or goes quiet without a verdict is started again once,
//! then the run fails as `check_error`. Every verdict is kept with its
//! result; a pass goes to the gate in the same write.

use std::sync::Arc;

use eos_contracts::builtin_tools::FILE_EDIT_BUILTIN_TOOLS;
use eos_contracts::{Blueprint, CheckVerdict, ItemRef, ResultDoc, RunInput, ToolScope};
use eos_core::Error;
use eos_core::store::{RUN_STATE_EVENT, RunMove, StoredRunResult};
use eos_domain::routine::run::{Reason, RunState, Station, next_attempt};
use eos_domain::run_scope::{RunRole, Trust};

use super::brief::word;
use super::control::confirmed_in;
use super::spawn::{self, RunSession};
use super::{Engine, gate, item_text, move_run, note};
use crate::routes::readable;

/// The definition a run's checker starts as; its tools and prompt key on it.
pub(crate) const CHECKER_DEFINITION: &str = "eos-run-checker";
/// The result kind that says there is nothing worth sending (01 G20).
pub(crate) const NOTHING: &str = "nothing";
/// A checker that ended without a verdict, on the run's timeline.
const CHECKER_FAILED: &str = "checker_failed";

/// What the check reads of a run waiting at it.
pub(crate) struct Checking {
    pub(crate) routine_id: String,
    pub(crate) blueprint: Blueprint,
    pub(crate) input: RunInput,
    pub(crate) trust: Trust,
    pub(crate) result: StoredRunResult,
    /// The Goes to the user confirmed; empty when no version is.
    goes_to: Vec<eos_contracts::Recipient>,
}

impl Checking {
    fn items(&self) -> impl Iterator<Item = &ItemRef> {
        self.input.item.iter().chain(self.input.items.iter().flatten())
    }
}

/// Starts the check of a run that just handed in its result.
pub(crate) fn begin(engine: &Arc<Engine>, run_id: &str) {
    let (engine, run_id) = (engine.clone(), run_id.to_owned());
    tokio::spawn(async move {
        if let Err(error) = check(&engine, &run_id).await {
            tracing::warn!(run_id, %error, "a run's result could not be checked");
            if let Err(error) = super::fail(&engine, &run_id, Reason::CheckError, None).await {
                tracing::error!(run_id, %error, "a run whose check broke could not be failed");
            }
            release_lead(&engine, &run_id).await;
        }
    });
}

async fn check(engine: &Arc<Engine>, run_id: &str) -> Result<(), Error> {
    let Some(checking) = read(engine, run_id).await? else { return Ok(()) };
    let attempt = checking.result.attempt;
    if checking.result.kind == NOTHING {
        return judged(engine, run_id, attempt, passing()).await;
    }
    let findings = rules(engine, &checking).await;
    if !findings.is_empty() {
        let verdict = CheckVerdict { pass: false, checks: Vec::new(), must_fix: findings };
        return judged(engine, run_id, attempt, verdict).await;
    }
    if !checking.blueprint.how.check_agent {
        return judged(engine, run_id, attempt, passing()).await;
    }
    start_checker(engine, run_id, &checking).await
}

fn passing() -> CheckVerdict {
    CheckVerdict { pass: true, checks: Vec::new(), must_fix: Vec::new() }
}

/// The run at its check, with the result of its round.
pub(crate) async fn read(engine: &Engine, run_id: &str) -> Result<Option<Checking>, Error> {
    let id = run_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let Some(run) = tx.runs().find(&id)?.filter(|run| run.state == RunState::Checking) else {
                return Ok(None);
            };
            let version_id = run.version_id.clone().unwrap_or_default();
            let Some(version) = tx.routine_versions().find(&run.routine_id, &version_id)? else { return Ok(None) };
            let Some(blueprint) = readable(&version)? else { return Ok(None) };
            let Some(result) = tx.run_results().by_run(&id)?.into_iter().find(|r| r.attempt == run.attempt) else {
                return Ok(None);
            };
            let input: RunInput =
                serde_json::from_str(&run.input).map_err(|_| Error::storage(format!("run {id} has no input")))?;
            let goes_to = match confirmed_in(tx, &run.routine_id) {
                Ok(confirmed) => confirmed.goes_to,
                Err(Error::NotFound { .. }) => Vec::new(),
                Err(error) => return Err(error),
            };
            let trust = eos_domain::routine::trust::of_run(Some(version.trust), &input);
            Ok(Some(Checking { routine_id: run.routine_id, blueprint, input, trust, result, goes_to }))
        })
        .await
}

/// The result as parts: as the lead wrote it when it is one, else its body
/// as one part.
pub(crate) fn result_doc(result: &StoredRunResult) -> ResultDoc {
    let body: serde_json::Value = serde_json::from_str(&result.body).unwrap_or(serde_json::Value::Null);
    if let Ok(doc) = serde_json::from_value::<ResultDoc>(body.clone()) {
        return doc;
    }
    let text = match body {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    };
    let part = eos_contracts::Part { key: "body".into(), role: "text".into(), text, meta: Default::default() };
    ResultDoc { kind: result.kind.clone(), channel: String::new(), action: String::new(), parts: vec![part] }
}

/// What the rules find wrong with the result, each a line the lead can act on.
async fn rules(engine: &Engine, checking: &Checking) -> Vec<String> {
    let mut findings = Vec::new();
    let (kind, makes) = (&checking.result.kind, &checking.blueprint.makes.kind);
    if kind != makes {
        findings.push(format!("The result is a {kind}; this routine makes a {makes}."));
    }
    if checking.blueprint.goes_to.iter().any(|recipient| !checking.goes_to.contains(recipient)) {
        findings.push("The routine sends to someone the user has not confirmed.".to_owned());
    }
    let doc = result_doc(&checking.result);
    for item in checking.items() {
        if let Err(text) = engine.reads.validate_result(kind, &doc, item).await {
            findings.push(text);
        }
    }
    findings
}

/// A checker session with the routine's checks, the item and the result.
async fn start_checker(engine: &Arc<Engine>, run_id: &str, checking: &Checking) -> Result<(), Error> {
    let blueprint = &checking.blueprint;
    let checker = &blueprint.who.checker;
    let read_only = ToolScope {
        allow: Vec::new(),
        deny: FILE_EDIT_BUILTIN_TOOLS.iter().map(|tool| (*tool).to_owned()).collect(),
        edit_regex: None,
    };
    let session = RunSession {
        run_id: run_id.to_owned(),
        routine_id: checking.routine_id.clone(),
        role: RunRole::Checker,
        role_word: "checker",
        agent_key: None,
        definition: CHECKER_DEFINITION,
        name: format!("{} · Checker", blueprint.name),
        model: checker.model.clone(),
        effort: word(&checker.effort),
        trust: checking.trust,
        fence: Some(read_only),
        place: super::workspace::Place::Scratch,
        parent_id: None,
        reads_outside: false,
        at: (RunState::Checking, Station::Check),
    };
    spawn::start(engine, session, |_| render(engine, checking)).await.map(drop)
}

fn render(engine: &Engine, checking: &Checking) -> Result<String, Error> {
    let blueprint = &checking.blueprint;
    let checks: Vec<String> =
        blueprint.how.checks.iter().map(|check| format!("- {}: {}", check.key, check.text)).collect();
    let items: Vec<String> = checking.items().map(item_text).collect();
    let result = format!("{}\n\n{}", checking.result.headline, checking.result.body);
    let pairs = [
        ("ROUTINE_NAME", blueprint.name.clone()),
        (
            "CHECKS",
            if checks.is_empty() { "No checks of its own: judge it by its brief.".into() } else { checks.join("\n") },
        ),
        ("BRIEF", blueprint.who.checker.brief.clone().unwrap_or_default()),
        ("ITEM", if items.is_empty() { "No item.".into() } else { items.join("\n\n") }),
        ("RESULT", result),
    ];
    let values = pairs.into_iter().map(|(name, value)| (name.to_owned(), serde_json::Value::String(value))).collect();
    engine.prompts.render("routine/check-brief", &values, &eos_prompts::service::no_values())
}

/// Where a verdict sends the run.
enum Next {
    /// It passed: the gate took it.
    Passed,
    /// Back to work, with what must change.
    Revise { lead: Option<String>, text: String },
    /// Its last round failed.
    Failed,
}

/// Keeps the verdict with the round's result and moves the run by it, in
/// one write. A run no longer at this round's check is left alone.
pub(crate) async fn judged(
    engine: &Arc<Engine>,
    run_id: &str,
    attempt: i64,
    verdict: CheckVerdict,
) -> Result<(), Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    let kept = serde_json::to_string(&verdict).map_err(|e| Error::storage(e.to_string()))?;
    let pass = verdict.pass;
    let job = engine.clone();
    let next = engine
        .store
        .write(move |tx, out| {
            let Some(run) = tx.runs().find(&id)?.filter(|r| r.state == RunState::Checking && r.attempt == attempt)
            else {
                return Ok(None);
            };
            tx.run_results().set_verdict(&id, attempt, &kept)?;
            if verdict.pass {
                gate::hand_over(&job, tx, out, &run, now)?;
                return Ok(Some(Next::Passed));
            }
            match next_attempt(attempt) {
                Some(round) => {
                    tx.runs().set_attempt(&id, round)?;
                    let work =
                        RunMove { state: RunState::Running, station: Some(Station::Work), reason: None, at: now };
                    move_run(tx, out, &run, work)?;
                    Ok(Some(Next::Revise { lead: run.lead_id.clone(), text: revise_text(&verdict) }))
                }
                None => {
                    let failed = RunMove {
                        state: RunState::Failed,
                        station: Some(Station::Check),
                        reason: Some(Reason::CheckFailed),
                        at: now,
                    };
                    move_run(tx, out, &run, failed)?;
                    super::failures::ended_in(&job, tx, out, &id, now)?;
                    Ok(Some(Next::Failed))
                }
            }
        })
        .await?;
    tracing::info!(run_id, attempt, pass, "a run's result was checked");
    match next {
        Some(Next::Revise { lead, text }) => {
            release_lead(engine, run_id).await;
            if let Some(lead) = lead {
                note(engine, &lead, run_id, &text).await?;
            }
        }
        Some(Next::Failed | Next::Passed) => {
            release_lead(engine, run_id).await;
            engine.wake.notify_one();
        }
        None => {}
    }
    Ok(())
}

fn revise_text(verdict: &CheckVerdict) -> String {
    let points: Vec<String> = verdict.must_fix.iter().map(|point| format!("- {point}")).collect();
    format!(
        "Your result did not pass its check. Fix these points, then call submit_result again:\n{}",
        points.join("\n")
    )
}

/// The lead of `run_id` takes messages again.
pub(crate) async fn release_lead(engine: &Engine, run_id: &str) {
    let id = run_id.to_owned();
    let lead = engine.store.read(move |tx| Ok(tx.runs().find(&id)?.and_then(|run| run.lead_id))).await;
    if let Ok(Some(lead)) = lead {
        Engine::locked(&engine.held).remove(&lead);
    }
}

/// The checker of a run at its check, by worker: the run's latest checker,
/// before its verdict. `None` for any other worker.
pub(crate) async fn current_checker(engine: &Engine, worker_id: &str) -> Result<Option<(String, i64)>, Error> {
    let id = worker_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let Some(session) = tx.routine_sessions().find(&id)?.filter(|s| s.role == "checker") else {
                return Ok(None);
            };
            let Some(run_id) = session.run_id else { return Ok(None) };
            let Some(run) = tx.runs().find(&run_id)?.filter(|run| run.state == RunState::Checking) else {
                return Ok(None);
            };
            let latest = tx.routine_sessions().by_run(&run_id)?.into_iter().rev().find(|s| s.role == "checker");
            let judged =
                tx.run_results().by_run(&run_id)?.iter().any(|r| r.attempt == run.attempt && r.verdict.is_some());
            let current = latest.is_some_and(|s| s.worker_id == id) && !judged;
            Ok(current.then_some((run_id, run.attempt)))
        })
        .await
}

/// A checker that ended or went quiet without its verdict: started again
/// once, then the run fails as `check_error`.
pub(crate) async fn checker_failed(engine: &Arc<Engine>, worker_id: &str) -> Result<(), Error> {
    let Some((run_id, _)) = current_checker(engine, worker_id).await? else { return Ok(()) };
    let (id, now) = (run_id.clone(), engine.clock.now_ms());
    let again = engine
        .store
        .write(move |tx, _| {
            let mut failures = 0;
            for event in tx.runs().events(&id)? {
                if event.kind == CHECKER_FAILED {
                    failures += 1;
                } else if event.kind == RUN_STATE_EVENT {
                    failures = 0;
                }
            }
            tx.runs().append_event(&id, now, CHECKER_FAILED, None)?;
            Ok(failures == 0)
        })
        .await?;
    tracing::warn!(run_id, worker_id, again, "a run's checker ended without a verdict");
    if !again {
        super::fail(engine, &run_id, Reason::CheckError, None).await?;
        release_lead(engine, &run_id).await;
        return Ok(());
    }
    let Some(checking) = read(engine, &run_id).await? else { return Ok(()) };
    start_checker(engine, &run_id, &checking).await
}

/// Whether a lead is held while its result is checked.
pub(crate) fn holds(engine: &Engine, worker_id: &str) -> bool {
    Engine::locked(&engine.held).contains(worker_id)
}
