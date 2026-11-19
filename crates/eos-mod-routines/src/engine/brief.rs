//! The brief station (01 §4.5, §4.7): the run's version is read and checked
//! again, its lead's `routine_sessions` row is written before the session
//! starts (so the first `worker:spawn` already finds it), the lead starts as
//! a focused session of the reserved definition with the run brief as its
//! first message, and the run goes to work.

use std::sync::Arc;

use eos_contracts::{AgentWorkspace, Blueprint, NameSource, RoutineAgent, RunInput, WhoDepth};
use eos_core::Error;
use eos_core::store::{RunMove, StoredRoutineSession};
use eos_domain::routine::blueprint::{Context, Severity, validate};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_sessions::SpawnRequest;

use super::{Engine, fail, move_run};
use crate::routes::readable;

/// The definition a solo run's lead starts as; its tools and prompt key on it.
pub(crate) const SOLO_DEFINITION: &str = "eos-run-solo";

/// What the headline of a run says when it could not start here.
const NOT_HERE: &str = "This routine's team or workspace needs a newer Eos.";
const NOT_VALID: &str = "This routine's blueprint no longer passes its rules.";

/// What the brief station starts the lead from.
struct Briefing {
    routine_id: String,
    blueprint: Blueprint,
    input: RunInput,
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

type Refusal = (Reason, Option<&'static str>, Option<Error>);

fn internal(error: Error) -> Refusal {
    (Reason::Internal, None, Some(error))
}

async fn brief(engine: &Arc<Engine>, run_id: &str) -> Result<(), Refusal> {
    let Some(briefing) = read(engine, run_id).await.map_err(internal)? else { return Ok(()) };
    let Briefing { routine_id, blueprint, input } = briefing;
    if !passes(&routine_id, &blueprint) {
        return Err((Reason::Invalid, Some(NOT_VALID), None));
    }
    let agent = match (blueprint.who.depth, blueprint.who.agents.as_slice()) {
        (WhoDepth::Solo, [agent]) if agent.workspace == AgentWorkspace::None => agent.clone(),
        _ => return Err((Reason::Invalid, Some(NOT_HERE), None)),
    };
    let worker_id = engine.ids.worker_id();
    let folder = engine.scratch.create(&worker_id).await.map_err(internal)?;
    if !record(engine, run_id, &routine_id, &worker_id, &agent).await.map_err(internal)? {
        engine.scratch.remove(&folder).await;
        return Ok(());
    }
    let (model, effort) = model_of(&blueprint, &agent, &input);
    let prompt = render(engine, &blueprint, &agent, &input, &folder).map_err(internal)?;
    let request = SpawnRequest {
        prompt,
        cwd: Some(folder.clone()),
        name: Some(format!("{} · {}", blueprint.name, agent.name)),
        name_source: Some(NameSource::Auto),
        model: Some(model),
        effort: Some(effort),
        role: Some(eos_contracts::FOCUSED_ROLE.to_owned()),
        worker_definition: Some(SOLO_DEFINITION.to_owned()),
        scratch: true,
        fixed_id: Some(worker_id.clone()),
        skip_recents: true,
        ..SpawnRequest::default()
    };
    if let Err(error) = engine.sessions.spawn(request).await {
        engine.scratch.remove(&folder).await;
        return Err(internal(error));
    }
    to_work(engine, run_id).await.map_err(internal)?;
    tracing::info!(run_id, worker_id, routine_id, "a run's lead started");
    Ok(())
}

/// The rules again, as at the version's keeping: what changed since (a
/// model, a capability) is the rules' to find. Chains and zones were checked
/// when the version was kept.
fn passes(routine_id: &str, blueprint: &Blueprint) -> bool {
    let context = Context { routine: routine_id, chains: &[], known_zone: &|_| true };
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
            Ok(Some(Briefing { routine_id: run.routine_id, blueprint, input }))
        })
        .await
}

/// The lead's `routine_sessions` row and the run's lead, written before the
/// session starts. False when the run left the brief meanwhile (stopped).
async fn record(
    engine: &Engine,
    run_id: &str,
    routine_id: &str,
    worker_id: &str,
    agent: &RoutineAgent,
) -> Result<bool, Error> {
    let row = StoredRoutineSession {
        worker_id: worker_id.to_owned(),
        routine_id: routine_id.to_owned(),
        run_id: Some(run_id.to_owned()),
        role: "solo".into(),
        agent_key: Some(agent.key.clone()),
        created_at: engine.clock.now_ms(),
    };
    let id = run_id.to_owned();
    engine
        .store
        .write(move |tx, _| {
            let at_brief = tx.runs().find(&id)?.is_some_and(|run| run.station == Some(Station::Brief));
            if at_brief {
                tx.routine_sessions().insert(&row)?;
                tx.runs().set_lead(&id, &row.worker_id)?;
            }
            Ok(at_brief)
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
fn model_of(blueprint: &Blueprint, agent: &RoutineAgent, input: &RunInput) -> (String, String) {
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

fn word<T: serde::Serialize>(value: &T) -> String {
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
    let how = format!("{}\n\nThe result's shape: {}", steps.join("\n"), blueprint.how.format);
    let limits = &blueprint.limits;
    let pairs = [
        ("ROUTINE_NAME", blueprint.name.clone()),
        ("SUMMARY", blueprint.summary.clone()),
        ("WHO", format!("{}: {}", agent.name, agent.brief)),
        ("HOW", how),
        ("MAKES", format!("{} ({})", blueprint.makes.description, blueprint.makes.kind)),
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

fn result_mode(input: &RunInput) -> String {
    match input.result {
        eos_contracts::ResultMode::Usual => "Eos handles the result as the routine allows.",
        eos_contracts::ResultMode::Ask => "Eos holds the result for the user to approve.",
        eos_contracts::ResultMode::ShowOnly => "Eos only shows the result; it is sent nowhere.",
    }
    .into()
}
