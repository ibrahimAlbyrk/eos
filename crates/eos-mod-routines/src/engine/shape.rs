//! What a run's result must look like, from the shape the channel that
//! sends it declares: the text its lead and checker read, and the check
//! that holds a result to it, so the two never differ.

use eos_contracts::ResultDoc;

use super::Engine;

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
