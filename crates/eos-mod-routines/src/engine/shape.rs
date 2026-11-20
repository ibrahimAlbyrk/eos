//! What a run's result must look like, from the shape the channel that
//! sends it declares: the text its lead and checker read, and the check
//! that holds a result to it, so the two never differ. The check runs when
//! the lead hands a result in, so a wrong shape costs no check round, and
//! again at the check station.

use eos_contracts::ResultDoc;
use eos_core::Error;
use serde_json::Value;

use super::Engine;
use super::check::{NOTHING, doc_of};
use crate::routes::readable;

/// The kind a routine makes and, when a channel here declares it, the shape
/// of its body with an example.
pub(crate) fn text(engine: &Engine, makes: &str) -> String {
    match engine.reads.result_shape(makes) {
        Some(shape) => shape.describe(),
        None => format!("Hand in kind `{makes}`."),
    }
}

/// What in a result of `kind`, whose body reads as `doc`, does not fit
/// what the routine makes, one line each, as the lead is told it.
pub(crate) fn misfits(engine: &Engine, kind: &str, makes: &str, doc: &ResultDoc) -> Vec<String> {
    let mut found = Vec::new();
    if kind != makes {
        found.push(format!("kind `{kind}`: this routine makes `{makes}`; hand in kind `{makes}`."));
    }
    if let Some(shape) = engine.reads.result_shape(makes) {
        found.extend(shape.check(doc));
    }
    found
}

/// Refuses a result handed in for `run_id` whose kind or shape does not fit
/// what its routine makes, with every point to fix.
pub(crate) async fn refuse_misfit(engine: &Engine, run_id: &str, kind: &str, body: &Value) -> Result<(), Error> {
    if kind == NOTHING {
        return Ok(());
    }
    let id = run_id.to_owned();
    let makes = engine
        .store
        .read(move |tx| {
            let Some(run) = tx.runs().find(&id)? else { return Ok(None) };
            let version_id = run.version_id.unwrap_or_default();
            let Some(version) = tx.routine_versions().find(&run.routine_id, &version_id)? else { return Ok(None) };
            Ok(readable(&version)?.map(|blueprint| blueprint.makes.kind))
        })
        .await?;
    let Some(makes) = makes else { return Ok(()) };
    let found = misfits(engine, kind, &makes, &doc_of(kind, body.clone()));
    if found.is_empty() {
        return Ok(());
    }
    let points: Vec<String> = found.iter().enumerate().map(|(n, point)| format!("({}) {point}", n + 1)).collect();
    Err(Error::Validation(format!(
        "The result was not handed in. Fix these points, then call submit_result again: {}",
        points.join(" ")
    )))
}
