//! The routes: the routines and their versions (`routines`), runs
//! (`runs`), what a routine may run on (`candidates`) and the run a worker
//! works for (`run_agents`).

mod architect;
mod candidates;
mod estimate;
mod routines;
mod run_agents;
mod run_view;
mod runs;
mod settings;
mod writes;

use std::sync::Arc;

use eos_core::Error;
use eos_runtime::http::ApiError;
use eos_runtime::router::RouteDef;

pub(crate) use candidates::item_ref;
pub(crate) use estimate::usual;
pub(crate) use routines::{BUILTIN, gone, param, readable, run_summary, showing_version, summary};
pub(crate) use runs::start_refused;
pub(crate) use settings::{current as current_settings, protected_settings, today};

use crate::engine::{Engine, NEWER_FORMAT};

/// 409 `newer_format`: the routine's version was made by a newer Eos
/// (G36): it is read here, never run, kept or changed.
pub(crate) fn newer_format() -> ApiError {
    ApiError::coded(409, NEWER_FORMAT, "newer_format")
}

/// A write's error as its route answers it.
pub(crate) fn refusal(error: Error) -> ApiError {
    match &error {
        Error::Conflict(message) if message == NEWER_FORMAT => newer_format(),
        _ => error.into(),
    }
}

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let mut routes = routines::all(&engine.store, &engine.clock);
    routes.extend(writes::all(engine));
    routes.extend(architect::all(engine));
    routes.extend(settings::all(engine));
    routes.extend(runs::all(engine));
    routes.extend(run_view::all(engine));
    routes.push(estimate::route(engine));
    routes.push(candidates::route(engine));
    routes.push(run_agents::route(engine));
    routes
}
