//! The routes: the routines and their versions (`routines`), runs
//! (`runs`), what a routine may run on (`candidates`) and the run a worker
//! works for (`run_agents`).

mod candidates;
mod estimate;
mod routines;
mod run_agents;
mod run_view;
mod runs;
mod settings;
mod writes;

use std::sync::Arc;

use eos_runtime::router::RouteDef;

pub(crate) use estimate::usual;
pub(crate) use routines::{gone, param, readable, run_summary, showing_version, summary};
pub(crate) use settings::{current as current_settings, protected_settings, today};

use crate::engine::Engine;

pub(crate) fn all(engine: &Arc<Engine>) -> Vec<RouteDef> {
    let mut routes = routines::all(&engine.store, &engine.clock);
    routes.extend(writes::all(engine));
    routes.extend(settings::all(engine));
    routes.extend(runs::all(engine));
    routes.extend(run_view::all(engine));
    routes.push(estimate::route(engine));
    routes.push(candidates::route(engine));
    routes.push(run_agents::route(engine));
    routes
}
