//! The `signal_sources` rows this module makes: one per place signals come
//! from, found by its scope hash and made the first time it is needed.

use eos_core::store::{StoredSignalSource, Tx};
use eos_core::{Error, Ids};

/// What names a source row.
pub(crate) struct SourceSpec<'a> {
    /// `clock`, `capability` or `after`.
    pub(crate) kind: &'a str,
    /// A capability's source (`github.pulls`).
    pub(crate) source: Option<&'a str>,
    pub(crate) scope_json: String,
    pub(crate) scope_hash: String,
    pub(crate) interval_ms: i64,
}

/// The row `spec` names, and whether this call made it.
pub(crate) fn source_in(
    tx: &dyn Tx,
    ids: &dyn Ids,
    spec: SourceSpec<'_>,
    now: i64,
) -> Result<(StoredSignalSource, bool), Error> {
    if let Some(source) = tx.signal_sources().by_scope(&spec.scope_hash)? {
        return Ok((source, false));
    }
    let source = StoredSignalSource {
        id: ids.signal_source_id(),
        kind: spec.kind.to_owned(),
        source: spec.source.map(str::to_owned),
        scope_json: spec.scope_json,
        scope_hash: spec.scope_hash,
        cursor_json: None,
        state: "active".into(),
        error_kind: None,
        failures: 0,
        interval_ms: spec.interval_ms,
        last_poll_at: None,
        next_poll_at: None,
        last_signal_at: None,
        catch_up_json: None,
        stopped_at: None,
        created_at: now,
        updated_at: now,
    };
    tx.signal_sources().insert(&source)?;
    tracing::info!(source_id = %source.id, kind = spec.kind, "a source was made");
    Ok((source, true))
}
