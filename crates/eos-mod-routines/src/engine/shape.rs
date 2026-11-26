//! What a run's result must look like, from the shape the channel that
//! sends it declares: the text its lead reads, and the check that holds a
//! result to it when the lead hands it in, so the two never differ. A
//! result that does not fit is refused there with what to fix, and the
//! lead hands it in again; the gate only ever sees one that fits.

use eos_contracts::RunInput;
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
/// what its routine makes, or that the channel's own check of it against
/// the run's items refuses, with every point to fix.
pub(crate) async fn refuse_misfit(engine: &Engine, run_id: &str, kind: &str, body: &Value) -> Result<(), Error> {
    if kind == NOTHING {
        return Ok(());
    }
    let id = run_id.to_owned();
    let found = engine
        .store
        .read(move |tx| {
            let Some(run) = tx.runs().find(&id)? else { return Ok(None) };
            if eos_contracts::SurfaceRunKind::is_surface_word(&run.kind) {
                return Ok(None);
            }
            let version_id = run.version_id.unwrap_or_default();
            let Some(version) = tx.routine_versions().find(&run.routine_id, &version_id)? else { return Ok(None) };
            let items = serde_json::from_str::<RunInput>(&run.input)
                .map(|input| input.item.into_iter().chain(input.items.into_iter().flatten()).collect::<Vec<_>>())
                .unwrap_or_default();
            Ok(readable(&version)?.map(|blueprint| (blueprint.makes.kind, items)))
        })
        .await?;
    let Some((makes, items)) = found else { return Ok(()) };
    let mut found = misfits(engine, kind, &makes, body);
    if found.is_empty() {
        let doc = doc_of(kind, body.clone());
        for item in &items {
            if let Err(texts) = engine.reads.validate_result(&makes, &doc, item).await {
                found.extend(texts);
            }
        }
    }
    if found.is_empty() {
        return Ok(());
    }
    let points: Vec<String> = found.iter().enumerate().map(|(n, point)| format!("({}) {point}", n + 1)).collect();
    Err(Error::Validation(format!(
        "The result was not handed in. Fix these points, then call submit_result again: {}",
        points.join(" ")
    )))
}
