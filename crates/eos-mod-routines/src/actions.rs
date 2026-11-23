//! What a routine's surface may do with its routine, through the
//! direct-action registry: run it again (`routine.run_again`), run it on an
//! item the surface shows (`routine.run_with`), open one of its runs
//! (`routine.open_run`); and read how it stands (`routine.status`) and its
//! last runs (`routine.runs`). Each acts only on the routine whose surface
//! was pressed.

use std::sync::Arc;

use eos_contracts::{ActionClass, ItemRef, ResultMode, RunInput};
use eos_core::routine::{NewRun, RunOrigin, RunStarter, StartError};
use eos_runtime::actions::{
    ActionCall, ActionDecl, ActionFailure, ActionHandler, ActionScope, QueryCall, QueryDecl, QueryHandler, no_args,
};
use eos_runtime::router::BoxFuture;
use eos_surface::{Field, Type};
use serde_json::{Value, json};

use crate::engine::{self, Engine};

/// The last runs `routine.runs` answers.
const RUNS_SHOWN: i64 = 10;

pub(crate) fn declared(engine: &Arc<Engine>) -> Vec<ActionDecl> {
    let starter: Arc<dyn RunStarter> = Arc::new(engine::Runs(engine.clone()));
    let decl = |id, title, args, class, handler: Arc<dyn ActionHandler>| ActionDecl {
        id,
        title,
        args,
        class,
        scope: ActionScope::OwnerRoutine,
        handler,
    };
    let with = Type::Object {
        fields: vec![Field::required("item", Type::Url), Field::optional("note", Type::Text { max: 500 })],
    };
    let open = Type::Object { fields: vec![Field::required("run", Type::Text { max: 64 })] };
    vec![
        decl("routine.run_again", "Run again", no_args(), ActionClass::WriteLocal, Arc::new(Start(starter.clone()))),
        decl("routine.run_with", "Run on this", with, ActionClass::WriteLocal, Arc::new(Start(starter))),
        decl("routine.open_run", "Open the run", open, ActionClass::Read, Arc::new(OpenRun(engine.clone()))),
    ]
}

pub(crate) fn queries(engine: &Arc<Engine>) -> Vec<QueryDecl> {
    let decl = |id, title, handler: Arc<dyn QueryHandler>| QueryDecl {
        id,
        title,
        args: no_args(),
        scope: ActionScope::OwnerRoutine,
        handler,
    };
    vec![
        decl("routine.status", "How the routine stands", Arc::new(Status(engine.clone()))),
        decl("routine.runs", "The routine's last runs", Arc::new(Runs(engine.clone()))),
    ]
}

fn routine_of(routine_id: Option<&String>) -> Result<String, ActionFailure> {
    routine_id.cloned().ok_or_else(|| ActionFailure::new("out_of_scope", "Only the routine's own surface runs it"))
}

fn internal(error: eos_core::Error) -> ActionFailure {
    ActionFailure::new("internal", error.to_string())
}

/// Why a start was refused, as the button shows it.
fn not_started(refused: StartError) -> ActionFailure {
    let (kind, reason) = match refused {
        StartError::SameItem { .. } => ("same_item", "The routine handled this lately".to_owned()),
        StartError::RoutineState(_) => ("routine_state", "The routine does not take runs now".to_owned()),
        StartError::DayCap => ("day_cap", "Routines spent today's budget".to_owned()),
        StartError::Halted => ("halted", "Eos is stopped".to_owned()),
        StartError::Unready(unready) => ("unready", unready.message()),
        StartError::UnknownRoutine(_) => ("not_found", "That routine is gone".to_owned()),
        StartError::NewerFormat => ("newer_format", "A newer Eos made this routine".to_owned()),
        StartError::Invalid(text) => ("invalid", text),
        StartError::Store(error) => ("internal", error.to_string()),
    };
    ActionFailure::new(kind, reason)
}

/// `routine.run_again` and `routine.run_with`: one run started from the
/// surface, keyed by the press's record so a repeat starts nothing more.
struct Start(Arc<dyn RunStarter>);

impl ActionHandler for Start {
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let routine_id = routine_of(call.routine_id.as_ref())?;
            let item = call.args["item"].as_str().map(|url| ItemRef {
                kind: "link".into(),
                key: None,
                title: None,
                url: Some(url.to_owned()),
                path: None,
                text: None,
                date: None,
                range: None,
                version: None,
                untrusted: true,
            });
            let input = RunInput {
                item,
                items: None,
                trigger: None,
                options: Default::default(),
                note: call.args["note"].as_str().map(str::to_owned),
                result: ResultMode::Usual,
                at: None,
            };
            let new = NewRun {
                routine_id,
                version: None,
                input,
                items: Vec::new(),
                origin: RunOrigin::Hand,
                door: Some("surface".into()),
                confirm_repeat: false,
                client_request_id: Some(call.record_id),
            };
            let made = self.0.start(new).await.map_err(not_started)?;
            let ids: Vec<&str> = made.iter().map(|run| run.id.as_str()).collect();
            Ok(json!({ "runIds": ids }))
        })
    }
}

struct OpenRun(Arc<Engine>);

impl ActionHandler for OpenRun {
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let routine_id = routine_of(call.routine_id.as_ref())?;
            let run_id = call.args["run"].as_str().unwrap_or_default().to_owned();
            let found = self.0.store.read(move |tx| tx.runs().find(&run_id)).await.map_err(internal)?;
            let run = found.filter(|run| run.routine_id == routine_id);
            let run = run.ok_or_else(|| ActionFailure::new("not_found", "That run is not this routine's"))?;
            Ok(json!({ "open": format!("eos:run/{}", run.id) }))
        })
    }
}

struct Status(Arc<Engine>);

impl QueryHandler for Status {
    fn read(&self, call: QueryCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let routine_id = routine_of(call.routine_id.as_ref())?;
            let read = self
                .0
                .store
                .read(move |tx| {
                    let routine = tx.routines().find(&routine_id)?;
                    Ok((routine, tx.runs().live_of(&routine_id)?.len(), tx.runs().by_routine(&routine_id, 1)?))
                })
                .await
                .map_err(internal)?;
            let (Some(routine), live, last) = read else {
                return Err(ActionFailure::new("not_found", "That routine is gone"));
            };
            let last =
                last.first().map(|run| json!({ "id": run.id, "state": run.state.as_str(), "headline": run.headline }));
            Ok(json!({ "name": routine.name, "state": routine.state, "live": live, "last": last }))
        })
    }
}

struct Runs(Arc<Engine>);

impl QueryHandler for Runs {
    fn read(&self, call: QueryCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        Box::pin(async move {
            let routine_id = routine_of(call.routine_id.as_ref())?;
            let runs = self.0.store.read(move |tx| tx.runs().by_routine(&routine_id, RUNS_SHOWN)).await;
            let runs: Vec<Value> = runs
                .map_err(internal)?
                .iter()
                .map(|run| json!({ "id": run.id, "state": run.state.as_str(), "headline": run.headline, "createdAt": run.created_at }))
                .collect();
            Ok(json!({ "runs": runs }))
        })
    }
}
