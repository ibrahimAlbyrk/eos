//! The brief station (01 §4.5, §4.7): the run's version is read and checked
//! again, its lead's `routine_sessions` row is written before the session
//! starts (so the first `worker:spawn` already finds it), the lead starts as
//! a focused session of the reserved definition with the run brief as its
//! first message and memory's notes for the item with it, and the run goes
//! to work.

use std::sync::Arc;

use eos_contracts::{Blueprint, RoutineAgent, RunInput, WhoDepth};
use eos_core::Error;
use eos_core::store::RunMove;
use eos_domain::routine::blueprint::{Context, Severity, validate};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::{RunRole, Trust};

use super::launch::fence_of;
use super::spawn::{self, RunSession};
use super::workspace::{self, NO_CLONE_HEADLINE, NO_LOCAL_CLONE, NoPlace};
use super::{Engine, fail, move_run};
use crate::routes::readable;

/// The definition a solo run's lead starts as; its tools and prompt key on it.
pub(crate) const SOLO_DEFINITION: &str = "eos-run-solo";
/// The definition a team's lead starts as.
pub(crate) const TEAM_LEAD_DEFINITION: &str = "eos-run-lead";

/// What the headline of a run says when it could not start here.
const NOT_HERE: &str = "This routine's team or workspace needs a newer Eos.";
const NOT_VALID: &str = "This routine's blueprint no longer passes its rules.";

/// What the brief station starts the lead from.
struct Briefing {
    routine_id: String,
    blueprint: Blueprint,
    input: RunInput,
    trust: Trust,
}

/// Starts the lead of a run at the brief. Whatever goes wrong fails the run
/// with the reason, never silently.
pub(crate) async fn start_lead(engine: &Arc<Engine>, run_id: &str) {
    match brief(engine, run_id).await {
        Ok(()) => {}
        Err((reason, headline, error)) => {
            if let Some(error) = &error {
                tracing::warn!(run_id, %error, reason = reason.as_str(), "a run's lead could not be started");
            }
            if let Err(error) = fail(engine, run_id, reason, headline.map(str::to_owned)).await {
                tracing::error!(run_id, %error, "a run that could not start could not be failed");
            }
        }
    }
}

pub(crate) type Refusal = (Reason, Option<&'static str>, Option<Error>);

fn internal(error: Error) -> Refusal {
    (Reason::Internal, None, Some(error))
}

async fn brief(engine: &Arc<Engine>, run_id: &str) -> Result<(), Refusal> {
    let Some(briefing) = read(engine, run_id).await.map_err(internal)? else { return Ok(()) };
    let Briefing { routine_id, blueprint, input, trust } = briefing;
    if !passes(&routine_id, &blueprint) {
        return Err((Reason::Invalid, Some(NOT_VALID), None));
    }
    let (agent, role, role_word, definition) = match (blueprint.who.depth, blueprint.who.agents.as_slice()) {
        (WhoDepth::Solo, [agent]) => (agent.clone(), RunRole::Solo, "solo", SOLO_DEFINITION),
        (WhoDepth::Team, agents) => match agents.iter().find(|agent| agent.lead) {
            Some(lead) => (lead.clone(), RunRole::Lead, "lead", TEAM_LEAD_DEFINITION),
            None => return Err((Reason::Invalid, Some(NOT_HERE), None)),
        },
        _ => return Err((Reason::Invalid, Some(NOT_HERE), None)),
    };
    let place = match workspace::place(engine, run_id, &blueprint, &input, &agent.key, agent.workspace, None).await {
        Ok(place) => place,
        Err(NoPlace::NoClone) => {
            no_clone(engine, run_id).await.map_err(internal)?;
            return Err((Reason::Invalid, Some(NO_CLONE_HEADLINE), None));
        }
        Err(NoPlace::Failed(error)) => return Err(internal(error)),
    };
    let (model, effort) = model_of(&blueprint, &agent, &input);
    let pack = super::memory::pack(engine, run_id, &routine_id, &input, &place).await;
    let session = RunSession {
        run_id: run_id.to_owned(),
        routine_id: routine_id.clone(),
        role,
        role_word,
        agent_key: Some(agent.key.clone()),
        definition,
        name: format!("{} · {}", blueprint.name, agent.name),
        model,
        effort,
        trust,
        fence: fence_of(&agent),
        place,
        parent_id: None,
        reads_outside: false,
        at: (RunState::Running, Station::Brief),
        pack,
    };
    let render = |folder: &str| render(engine, &blueprint, &agent, &input, folder);
    let Some(worker_id) = spawn::start(engine, session, render).await.map_err(internal)? else { return Ok(()) };
    to_work(engine, run_id).await.map_err(internal)?;
    tracing::info!(run_id, worker_id, routine_id, "a run's lead started");
    Ok(())
}

/// Puts on the run's timeline that its repository has no local clone.
pub(crate) async fn no_clone(engine: &Engine, run_id: &str) -> Result<(), Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    engine.store.write(move |tx, _| tx.runs().append_event(&id, now, NO_LOCAL_CLONE, None)).await
}

/// The rules again, as at the version's keeping: what changed since (a
/// model, a capability) is the rules' to find. Chains and zones were checked
/// when the version was kept.
fn passes(routine_id: &str, blueprint: &Blueprint) -> bool {
    let context = Context { routine: routine_id, chains: &[], known_zone: &|_| true, data_dir: None };
    !validate(blueprint, &context).iter().any(|issue| issue.severity == Severity::Error)
}

/// The run's routine, version and input, while the run is still at the
/// brief.
async fn read(engine: &Engine, run_id: &str) -> Result<Option<Briefing>, Error> {
    let id = run_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let Some(run) = tx.runs().find(&id)? else { return Ok(None) };
            if (run.state, run.station) != (RunState::Running, Some(Station::Brief)) {
                return Ok(None);
            }
            let version_id = run.version_id.clone().unwrap_or_default();
            let Some(version) = tx.routine_versions().find(&run.routine_id, &version_id)? else { return Ok(None) };
            let Some(blueprint) = readable(&version)? else { return Ok(None) };
            let input: RunInput =
                serde_json::from_str(&run.input).map_err(|_| Error::storage(format!("run {id} has no input")))?;
            let trust = eos_domain::routine::trust::of_run(Some(version.trust), &input);
            Ok(Some(Briefing { routine_id: run.routine_id, blueprint, input, trust }))
        })
        .await
}

async fn to_work(engine: &Engine, run_id: &str) -> Result<(), Error> {
    let (id, now) = (run_id.to_owned(), engine.clock.now_ms());
    engine
        .store
        .write(move |tx, out| {
            let Some(run) = tx.runs().find(&id)?.filter(|run| run.state == RunState::Running) else { return Ok(()) };
            let work = RunMove { state: RunState::Running, station: Some(Station::Work), reason: None, at: now };
            move_run(tx, out, &run, work).map(drop)
        })
        .await
}

/// The agent's model and effort, after the options that switch them for the
/// values this run was given (01 §4.3 `affects`).
pub(crate) fn model_of(blueprint: &Blueprint, agent: &RoutineAgent, input: &RunInput) -> (String, String) {
    let mut model = agent.model.clone();
    let mut effort = word(&agent.effort);
    for option in &blueprint.options {
        let value = input.options.get(&option.key).unwrap_or(&option.default);
        let value = match value {
            serde_json::Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        for affect in option.affects.iter().flatten().filter(|affect| affect.agent == agent.key) {
            if let Some(chosen) = affect.model.as_ref().and_then(|models| models.get(&value)) {
                model = chosen.clone();
            }
            if let Some(chosen) = affect.effort.as_ref().and_then(|efforts| efforts.get(&value)) {
                effort = word(chosen);
            }
        }
    }
    (model, effort)
}

pub(crate) fn word<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The lead's first message, from `routine/run-brief`. Item text from
/// outside is wrapped so the lead reads it as data.
fn render(
    engine: &Engine,
    blueprint: &Blueprint,
    agent: &RoutineAgent,
    input: &RunInput,
    folder: &str,
) -> Result<String, Error> {
    let items: Vec<String> = input.item.iter().chain(input.items.iter().flatten()).map(super::item_text).collect();
    let options: Vec<String> = blueprint
        .options
        .iter()
        .map(|option| {
            let value = input.options.get(&option.key).unwrap_or(&option.default);
            format!("- {}: {value}", option.label)
        })
        .collect();
    let steps: Vec<String> = blueprint.how.steps.iter().map(|step| format!("- {step}")).collect();
    let how = format!("{}\n\nHow the result reads: {}", steps.join("\n"), blueprint.how.format);
    let limits = &blueprint.limits;
    let pairs = [
        ("ROUTINE_NAME", blueprint.name.clone()),
        ("SUMMARY", blueprint.summary.clone()),
        ("WHO", who(blueprint, agent)),
        ("HOW", how),
        ("MAKES", format!("{} ({})", blueprint.makes.description, blueprint.makes.kind)),
        ("RESULT_SHAPE", super::shape::text(engine, &blueprint.makes.kind)),
        ("ITEM", if items.is_empty() { "No item: this run works on its own.".into() } else { items.join("\n\n") }),
        ("OPTIONS", if options.is_empty() { "None.".into() } else { options.join("\n") }),
        ("NOTE", input.note.clone().unwrap_or_else(|| "None.".into())),
        ("RESULT_MODE", result_mode(input)),
        ("BUDGET", format!("${} and {} minutes for this run.", limits.per_run_usd, limits.per_run_minutes)),
        ("CHECKOUT", folder.to_owned()),
    ];
    let values = pairs.into_iter().map(|(name, value)| (name.to_owned(), serde_json::Value::String(value))).collect();
    engine.prompts.render("routine/run-brief", &values, &eos_prompts::service::no_values())
}

/// The lead and, for a team, each specialist by the key the team tools take.
fn who(blueprint: &Blueprint, lead: &RoutineAgent) -> String {
    let mut lines = vec![format!("{}: {}", lead.name, lead.brief)];
    if blueprint.who.depth == WhoDepth::Team {
        lines.push("\nYour team (start each with start_specialist by its key):".to_owned());
        let team = blueprint.who.agents.iter().filter(|agent| !agent.lead);
        lines.extend(team.map(|agent| format!("- {} ({}): {}", agent.key, agent.name, agent.brief)));
    }
    lines.join("\n")
}

fn result_mode(input: &RunInput) -> String {
    match input.result {
        eos_contracts::ResultMode::Usual => "Eos handles the result as the routine allows.",
        eos_contracts::ResultMode::Ask => "Eos holds the result for the user to approve.",
        eos_contracts::ResultMode::ShowOnly => "Eos only shows the result; it is sent nowhere.",
    }
    .into()
}
