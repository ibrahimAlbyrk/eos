//! Surfaces at a routine's life (05 §4): a routine whose blueprint makes a
//! view, a page or an app has its surface created with it, kept when it
//! starts, archived with it and brought back with it. Each call follows the
//! routine's committed write; a surface failing never undoes it.

use eos_core::Error;

use super::Engine;
use crate::routes::{readable, showing_version};

/// The kinds of result a surface shows.
const SURFACE_KINDS: [&str; 3] = ["view", "page", "app"];

fn is_surface(makes: &str) -> bool {
    SURFACE_KINDS.contains(&makes)
}

/// What the routine's version shown now makes.
async fn makes(engine: &Engine, routine_id: &str) -> Result<Option<String>, Error> {
    let id = routine_id.to_owned();
    engine
        .store
        .read(move |tx| {
            let Some(version) = showing_version(tx, &id)? else { return Ok(None) };
            Ok(readable(&version)?.map(|blueprint| blueprint.makes.kind))
        })
        .await
}

fn warn(routine_id: &str, what: &'static str, error: &Error) {
    tracing::warn!(routine_id, what, %error, "a routine's surface did not follow it");
}

/// A routine was made from `version_id`, whose blueprint makes `makes`.
pub(crate) async fn created(engine: &Engine, routine_id: &str, version_id: &str, makes: &str) {
    if is_surface(makes)
        && let Err(error) = engine.surfaces.create_for_routine(routine_id, version_id, makes).await
    {
        warn(routine_id, "create", &error);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Move {
    Keep,
    Archive,
    Restore,
}

/// The routine started, was archived or deleted, or came back.
pub(crate) async fn moved(engine: &Engine, routine_id: &str, to: Move) {
    let makes = match makes(engine, routine_id).await {
        Ok(makes) => makes,
        Err(error) => return warn(routine_id, "read", &error),
    };
    if !makes.as_deref().is_some_and(is_surface) {
        return;
    }
    let done = match to {
        Move::Keep => engine.surfaces.keep(routine_id).await,
        Move::Archive => engine.surfaces.archive_for_routine(routine_id).await,
        Move::Restore => engine.surfaces.restore_for_routine(routine_id).await,
    };
    if let Err(error) = done {
        warn(routine_id, "move", &error);
    }
}
