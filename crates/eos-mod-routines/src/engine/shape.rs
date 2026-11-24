//! What a run's result must look like, from the shape the channel that
//! sends it declares: the text its lead and checker read, and the check
//! that holds a result to it, so the two never differ. The check runs when
//! the lead hands a result in, so a wrong shape costs no check round, and
//! again at the check station.

use eos_core::Error;
use eos_domain::result_doc::shape::{ResultShape, body_misfits};
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

/// What in a result of `kind` whose body is `body` does not fit what the
/// routine makes, one line each, as the lead is told it.
pub(crate) fn misfits(engine: &Engine, kind: &str, makes: &str, body: &Value) -> Vec<String> {
    let mut found = Vec::new();
    if kind != makes {
        found.push(format!("kind `{kind}`: this routine makes `{makes}`; hand in kind `{makes}`."));
    }
    if let Some(shape) = engine.reads.result_shape(makes) {
        found.extend(body_fits(&shape, kind, body));
    }
    found
}

/// An object that does not read as a result is told the field it lacks,
/// and JSON handed in as text is told to come as an object, before the
/// shape is checked: read as plain text, either would be told of parts it
/// does not have.
fn body_fits(shape: &ResultShape, kind: &str, body: &Value) -> Vec<String> {
    let unread = body_misfits(body);
    if !unread.is_empty() {
        return unread;
    }
    let holds_json =
        body.as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).is_some_and(|v| v.is_object());
    if holds_json {
        return vec!["body: pass the result as one object, not as text holding JSON.".to_owned()];
    }
    shape.check(&doc_of(kind, body.clone()))
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
            if eos_contracts::SurfaceRunKind::is_surface_word(&run.kind) {
                return Ok(None);
            }
            let version_id = run.version_id.unwrap_or_default();
            let Some(version) = tx.routine_versions().find(&run.routine_id, &version_id)? else { return Ok(None) };
            Ok(readable(&version)?.map(|blueprint| blueprint.makes.kind))
        })
        .await?;
    let Some(makes) = makes else { return Ok(()) };
    let found = misfits(engine, kind, &makes, body);
    if found.is_empty() {
        return Ok(());
    }
    let points: Vec<String> = found.iter().enumerate().map(|(n, point)| format!("({}) {point}", n + 1)).collect();
    Err(Error::Validation(format!(
        "The result was not handed in. Fix these points, then call submit_result again: {}",
        points.join(" ")
    )))
}
