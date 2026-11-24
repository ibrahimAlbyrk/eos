//! Script depth (01 G9, D52). A script routine's lead is a focused session
//! on a small model; its brief tells it to call `Workflow` with the kept
//! script's path and the run's `args`. The engine refuses a `scriptPath`
//! outside the session's folders, so Eos's gate reads the kept file itself,
//! checks its SHA-256 against the version the run runs and lets the call
//! through with the script inline ([`KeptScripts`]). Every other `Workflow`
//! call of the lead is refused: a saved workflow by `name`, an inline
//! `script`, another `scriptPath` (the session's own saved copy among them)
//! and `resumeFromRunId`. Inline, the engine's determinism rule refuses the
//! clock and randomness in the script, so the time comes in `args.now`.

use std::sync::Arc;

use eos_contracts::{AgentTools, AgentWorkspace, Blueprint, Effort, RoutineAgent, RunInput, UnknownRecord, WhoDepth};
use eos_core::policy::{KeptScripts, ScriptCall};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::blueprint::hash;
use eos_domain::routine::run::{RunState, Station};
use eos_domain::run_scope::RunRole;
use serde_json::{Value, json};

use super::Engine;
use crate::routes::readable;

/// The definition a script routine's lead starts as.
pub(crate) const SCRIPT_DEFINITION: &str = "eos-run-script";
/// The lead only starts the script and hands in what it made.
const SCRIPT_LEAD_MODEL: &str = "haiku";

/// The keys of the one `Workflow` call a script's lead may make.
const SCRIPT_PATH: &str = "scriptPath";
const ARGS: &str = "args";

/// The lead of a script routine's run.
pub(crate) fn lead_of(blueprint: &Blueprint) -> Option<RoutineAgent> {
    (blueprint.who.depth == WhoDepth::Script && blueprint.who.script.is_some()).then(|| RoutineAgent {
        key: "script".into(),
        name: "Script".into(),
        lead: true,
        brief: "Run the routine's script, then hand in what it made.".into(),
        model: SCRIPT_LEAD_MODEL.into(),
        effort: Effort::Low,
        tools: AgentTools { allow: Vec::new(), deny: Vec::new(), extra: Default::default() },
        reads_outside: false,
        workspace: AgentWorkspace::None,
        extra: Default::default(),
    })
}

/// Writes the version's script where the lead's call names it, and answers
/// what the brief tells the lead to call.
pub(crate) async fn keep(
    engine: &Engine,
    routine_id: &str,
    version_id: &str,
    blueprint: &Blueprint,
    input: &RunInput,
) -> Result<Option<String>, Error> {
    let Some(script) = &blueprint.who.script else { return Ok(None) };
    let path = engine.folders.keep_script(routine_id, version_id, &script.source).await?;
    let args = json!({
        "item": input.item,
        "items": input.items,
        "options": input.options,
        "note": input.note,
        "now": engine.clock.now_ms(),
    });
    let call = json!({ SCRIPT_PATH: path.to_string_lossy(), ARGS: args });
    Ok(Some(format!(
        "Run the routine's script: call Workflow once with exactly this input, then hand in what the script made \
         with submit_result. Never edit the script or call Workflow any other way.\n{call}"
    )))
}

/// The routines port Eos's gate checks a `Workflow` call through.
pub(crate) struct Scripts(pub(crate) Arc<Engine>);

impl KeptScripts for Scripts {
    fn check<'a>(&'a self, worker_id: &'a str, input: &'a UnknownRecord) -> BoxFuture<'a, Result<ScriptCall, Error>> {
        Box::pin(check(&self.0, worker_id, input))
    }
}

fn refused(why: &str) -> ScriptCall {
    ScriptCall::Refused(format!(
        "Refused: {why} A routine's lead runs only its kept script, by the path its brief names."
    ))
}

async fn check(engine: &Engine, worker_id: &str, input: &UnknownRecord) -> Result<ScriptCall, Error> {
    let id = worker_id.to_owned();
    let found = engine
        .store
        .read(move |tx| {
            let Some(run_ref) = tx.routine_sessions().run_of(&id)? else { return Ok(None) };
            let run = tx.runs().find(&run_ref.run_id)?;
            let version = match run.as_ref().and_then(|run| run.version_id.clone()) {
                Some(version_id) => tx.routine_versions().find(&run_ref.routine_id, &version_id)?,
                None => None,
            };
            let blueprint = version.as_ref().map(readable).transpose()?.flatten();
            Ok(Some((run_ref, run, version.map(|version| version.id), blueprint)))
        })
        .await?;
    // Not a run's session: the policy decides as for any session.
    let Some((run_ref, run, version_id, blueprint)) = found else { return Ok(ScriptCall::NotOurs) };
    if run_ref.role != RunRole::Script {
        return Ok(refused("this run session has no script to run."));
    }
    let at_work = run.is_some_and(|run| (run.state, run.station) == (RunState::Running, Some(Station::Work)));
    let (Some(version_id), Some(script)) = (version_id, blueprint.and_then(|blueprint| blueprint.who.script)) else {
        return Ok(refused("the run's version has no script."));
    };
    if !at_work {
        return Ok(refused("the run is not at work."));
    }
    if let Some(key) = input.keys().find(|key| *key != SCRIPT_PATH && *key != ARGS) {
        return Ok(refused(&format!("`{key}` is not taken.")));
    }
    let expected = engine.folders.script_path(&run_ref.routine_id, &version_id);
    if input.get(SCRIPT_PATH).and_then(Value::as_str) != Some(expected.to_string_lossy().as_ref()) {
        return Ok(refused("that is not the routine's kept script."));
    }
    let Some(source) = engine.folders.read_script(&run_ref.routine_id, &version_id).await? else {
        return Ok(refused("the kept script is missing."));
    };
    if hash(&source) != script.hash {
        tracing::warn!(run_id = %run_ref.run_id, "a routine's kept script changed on disk");
        return Ok(refused("the kept script changed since the routine was kept."));
    }
    let mut inline = UnknownRecord::new();
    inline.insert("script".into(), Value::String(source));
    inline.insert(ARGS.into(), input.get(ARGS).cloned().unwrap_or_else(|| json!({})));
    tracing::info!(run_id = %run_ref.run_id, worker_id, "a routine's kept script runs");
    Ok(ScriptCall::Run(inline))
}
