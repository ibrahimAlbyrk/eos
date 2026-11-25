//! What of routines follows the user to their other computers (01 G2,
//! G37, G49): the domain `routine` holds each routine (`<rid>`: its name,
//! slug, kind, state and head) and every kept version (`<rid>/<vid>`,
//! never changed once written); the domain `run` holds a summary of each
//! finished run of the last 30 days, with no result and no transcript.
//! Built-in routines, drafts, one-offs and trials stay on their computer.

mod routine;
mod run;

pub(crate) use routine::RoutineRecords;
pub(crate) use run::{RUN_SUMMARIES_KEPT_MS, RunRecords, synced_of};

use eos_core::Error;
use eos_core::store::StoredRoutine;

fn travels(routine: &StoredRoutine) -> bool {
    routine.travels()
}

fn refused(what: impl std::fmt::Display) -> Error {
    Error::Validation(what.to_string())
}
