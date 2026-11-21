//! Forgetting a note and bringing it back. A forgotten note stays in the
//! store, out of every recall and list, with a record in `mem_forgotten`:
//! its fingerprint (hooks and text), which keeps it from being learned again,
//! and a snapshot that brings it back. It can be brought back for
//! [`RESTORE_MS`]; the record is kept for 90 days.

use eos_contracts::ExperienceChange;
use eos_core::Error;
use eos_core::store::{Outbox, StoredForgotten, Tx};
use eos_domain::experience::Note;
use serde_json::{Value, json};

use crate::merge::{MEMORY_CHANGE, version};

/// How long a forgotten note can be brought back.
pub const RESTORE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Where the last "Forget everything learned" is kept: its time.
const FORGET_ALL_AT: &str = "forget_all.at";

/// What bringing a note back came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restored {
    Done,
    /// Not forgotten, or no such note.
    NotForgotten,
    /// Forgotten longer than [`RESTORE_MS`] ago.
    TooLate,
}

/// The note as JSON, as a snapshot keeps it.
pub fn snapshot(note: &Note) -> Value {
    json!({
        "id": note.id,
        "kind": note.kind.as_str(),
        "text": note.text,
        "body": note.body,
        "trust": note.trust.as_str(),
        "state": note.state.as_str(),
        "scope": {"level": note.scope.level.as_str(), "key": note.scope.key},
        "validFrom": note.valid_from,
        "validTo": note.valid_to,
        "replacedBy": note.replaced_by,
        "do": note.do_hooks,
        "avoid": note.avoid_hooks,
        "createdAt": note.created_at,
        "updatedAt": note.updated_at,
        "device": note.device,
    })
}

/// Forgets a note inside the caller's write job. `false` when there is no
/// such note or it is forgotten already.
pub fn forget_in(tx: &dyn Tx, out: &mut Outbox, note_id: &str, now: i64) -> Result<bool, Error> {
    let Some(stored) = tx.mem_notes().find(note_id)? else { return Ok(false) };
    if stored.forgotten_at.is_some() {
        return Ok(false);
    }
    let hooks: Vec<String> = tx
        .mem_graph()
        .links(&[note_id.to_owned()])?
        .into_iter()
        .filter(|l| l.rel == "about" && l.a == note_id)
        .map(|l| l.b)
        .collect();
    let fingerprint = json!({"hooks": hooks, "text": stored.note.text});
    tx.mem_book().put_forgotten(&StoredForgotten {
        note_id: note_id.to_owned(),
        fingerprint: fingerprint.to_string(),
        snapshot: snapshot(&stored.note).to_string(),
        at: now,
    })?;
    tx.mem_notes().set_forgotten(note_id, Some(now))?;
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![note_id.to_owned()], action: "forgotten".into() });
    Ok(true)
}

/// Brings a forgotten note back inside the caller's write job, as a new
/// version written by `device`.
pub fn restore_in(tx: &dyn Tx, out: &mut Outbox, note_id: &str, device: &str, now: i64) -> Result<Restored, Error> {
    let Some(stored) = tx.mem_notes().find(note_id)? else { return Ok(Restored::NotForgotten) };
    let Some(at) = stored.forgotten_at else { return Ok(Restored::NotForgotten) };
    if now - at > RESTORE_MS {
        return Ok(Restored::TooLate);
    }
    let mut note = stored.note.clone();
    note.updated_at = now.max(note.updated_at);
    note.device = device.to_owned();
    tx.mem_notes().set_forgotten(note_id, None)?;
    tx.mem_notes().update(&note, &stored.cues, stored.rev + 1)?;
    tx.mem_versions().insert(&version(&note, stored.rev + 1, "restored", now))?;
    tx.mem_book().remove_forgotten(note_id)?;
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![note_id.to_owned()], action: "changed".into() });
    Ok(Restored::Done)
}

/// Forgets every note inside the caller's write job, and clears what was
/// captured, used and the meaning vectors; About you is not memory's and
/// stays. Answers how many notes were forgotten.
pub fn forget_all_in(tx: &dyn Tx, out: &mut Outbox, now: i64) -> Result<usize, Error> {
    let mut forgotten = 0;
    for id in tx.mem_notes().ids()? {
        forgotten += usize::from(forget_in(tx, out, &id, now)?);
    }
    tx.mem_moments().clear()?;
    tx.mem_uses().clear()?;
    tx.mem_vectors().clear()?;
    tx.mem_book().set_setting(FORGET_ALL_AT, &now.to_string())?;
    Ok(forgotten)
}

/// Brings back every note the last "Forget everything learned" forgot,
/// inside the caller's write job: how many, or `TooLate` past
/// [`RESTORE_MS`] (`NotForgotten` when there was none).
pub fn undo_forget_all_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    device: &str,
    now: i64,
) -> Result<Result<usize, Restored>, Error> {
    let Some(at) = tx.mem_book().setting(FORGET_ALL_AT)?.and_then(|at| at.parse::<i64>().ok()) else {
        return Ok(Err(Restored::NotForgotten));
    };
    if now - at > RESTORE_MS {
        return Ok(Err(Restored::TooLate));
    }
    let mut restored = 0;
    for forgotten in tx.mem_book().forgotten_since(at)?.into_iter().filter(|f| f.at == at) {
        restored += usize::from(restore_in(tx, out, &forgotten.note_id, device, now)? == Restored::Done);
    }
    tx.mem_book().set_setting(FORGET_ALL_AT, "")?;
    Ok(Ok(restored))
}
