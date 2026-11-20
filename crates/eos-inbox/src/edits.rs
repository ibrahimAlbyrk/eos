//! What the user changed of a result before it went out (03 G4, G7): one
//! row of `inbox_edits` per sent draft that differs from what was held,
//! with both results, the part edits and a count per kind of edit. A part
//! the user removed (a comment, a recipient) is an edit. Memory reads them
//! later through [`Edits`], in order.

use std::sync::Arc;

use eos_contracts::{EditOp, PartEdit, ResultDoc};
use eos_core::inbox::{ResultEdit, ResultEdits};
use eos_core::store::{NewEdit, Store, StoredEdit, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::result_doc::diff;

/// A sent draft, as held and as sent.
pub(crate) struct Sent<'a> {
    pub(crate) item_id: &'a str,
    pub(crate) delivery_id: Option<String>,
    pub(crate) routine_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) before: &'a ResultDoc,
    pub(crate) after: &'a ResultDoc,
    /// The draft was made from text from outside.
    pub(crate) untrusted: bool,
    pub(crate) at: i64,
}

fn storage(error: serde_json::Error) -> Error {
    Error::storage(error.to_string())
}

/// Writes the edit of `sent`, if any part changed past normalising; its
/// number.
pub(crate) fn capture_in(tx: &dyn Tx, sent: Sent<'_>) -> Result<Option<i64>, Error> {
    let ops = diff(sent.before, sent.after);
    if ops.is_empty() {
        return Ok(None);
    }
    let count = |op: EditOp| ops.iter().filter(|edit| edit.op == op).count() as i64;
    let edit = NewEdit {
        item_id: sent.item_id.to_owned(),
        delivery_id: sent.delivery_id,
        routine_id: sent.routine_id.to_owned(),
        run_id: sent.run_id.to_owned(),
        result_kind: sent.before.kind.clone(),
        before: serde_json::to_string(sent.before).map_err(storage)?,
        after: serde_json::to_string(sent.after).map_err(storage)?,
        ops: serde_json::to_string(&ops).map_err(storage)?,
        changed: count(EditOp::Changed),
        removed: count(EditOp::Removed),
        added: count(EditOp::Added),
        moved: count(EditOp::Moved),
        derived_from_untrusted: sent.untrusted,
        at: sent.at,
    };
    let id = tx.inbox_edits().insert(&edit)?;
    tracing::info!(
        edit_id = id,
        item_id = sent.item_id,
        changed = edit.changed,
        removed = edit.removed,
        added = edit.added,
        moved = edit.moved,
        "a result was edited before it went out"
    );
    Ok(Some(id))
}

/// A stored edit as memory reads it; none for a row this app cannot read.
fn read(stored: StoredEdit) -> Option<ResultEdit> {
    let StoredEdit { id, edit } = stored;
    Some(ResultEdit {
        id,
        item_id: edit.item_id,
        delivery_id: edit.delivery_id,
        routine_id: edit.routine_id,
        run_id: edit.run_id,
        before: serde_json::from_str(&edit.before).ok()?,
        after: serde_json::from_str(&edit.after).ok()?,
        ops: serde_json::from_str::<Vec<PartEdit>>(&edit.ops).ok()?,
        derived_from_untrusted: edit.derived_from_untrusted,
        at: edit.at,
    })
}

/// The user's edits of results, over `inbox_edits`.
#[derive(Clone)]
pub struct Edits {
    store: Arc<dyn Store>,
}

impl std::fmt::Debug for Edits {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Edits").finish_non_exhaustive()
    }
}

impl Edits {
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self { store }
    }
}

impl ResultEdits for Edits {
    fn list_since(&self, cursor: i64, limit: usize) -> BoxFuture<'_, Result<Vec<ResultEdit>, Error>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        Box::pin(async move {
            let rows = self.store.read(move |tx| tx.inbox_edits().since(cursor, limit)).await?;
            Ok(rows.into_iter().filter_map(read).collect())
        })
    }

    fn get(&self, edit_id: i64) -> BoxFuture<'_, Result<Option<ResultEdit>, Error>> {
        Box::pin(async move {
            let row = self.store.read(move |tx| tx.inbox_edits().find(edit_id)).await?;
            Ok(row.and_then(read))
        })
    }
}
