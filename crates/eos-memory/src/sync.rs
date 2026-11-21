//! What memory's sync records hold, and how a record from another Mac is
//! taken in (04 G8). Two kinds of record:
//!
//! - `n-<note id>`: the note, the hooks it is about and the links it starts
//!   (their structure, not their weights), its newest evidence summaries and
//!   how many versions it has. A forgotten note travels as
//!   `{forgotten, at, fingerprint}` so no Mac learns it again; the record
//!   goes when the forgotten record is pruned.
//! - `c-<device>-<shard>`: one Mac's counters of the notes in one of 256
//!   shards. Each Mac writes only its own; states are worked out from the
//!   summed counters on each Mac and never travel.
//!
//! When two Macs changed a note, [`merge`] keeps the newer text (the device
//! breaks a tie) and the union of evidence and links; a forgotten side wins.
//! Once memory fills most of its vault share, closed episodes older than
//! [`OLD_EPISODE_MS`] travel without their text (D26). Every write here is
//! announced on `memory:change` as `synced`, so it is not pushed back as a
//! local edit.

use std::collections::BTreeMap;

use eos_contracts::ExperienceChange;
use eos_core::Error;
use eos_core::store::{Outbox, StoredCredit, StoredEvidence, StoredForgotten, StoredHook, StoredLink, StoredNote, Tx};
use eos_domain::experience::state::Counters;
use eos_domain::experience::{HookKind, Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust};
use eos_domain::sync::SyncItem;
use serde_json::{Map, Value, json};

use crate::merge::MEMORY_CHANGE;

/// A note's record id is this and the note's id.
pub const NOTE_RECORD: &str = "n-";
/// A Mac's counters record id is this, the device and the shard.
pub const COUNTER_RECORD: &str = "c-";
/// The evidence summaries a note's record carries, newest first.
const EVIDENCE_SYNCED: i64 = 8;
/// The share of memory's vault budget past which old episodes travel
/// without their text (D26).
pub const OLD_EPISODE_TEXT_DROP: f64 = 0.8;
/// How old a closed episode is before its text may stay behind (D26).
pub const OLD_EPISODE_MS: i64 = 180 * 24 * 60 * 60 * 1000;
/// What `memory:change` says of a write that came from another Mac.
pub const SYNCED: &str = "synced";

/// The shard of a note's counters: one of 256, by its id.
pub fn shard(note_id: &str) -> String {
    let sum = note_id.bytes().fold(0u32, |acc, byte| acc.wrapping_mul(31).wrapping_add(u32::from(byte)));
    format!("{:02x}", sum % 256)
}

/// The record id of `device`'s counters in `shard`.
pub fn counter_record(device: &str, shard: &str) -> String {
    format!("{COUNTER_RECORD}{device}-{shard}")
}

/// How notes travel at this moment: whether old episodes drop their text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Travel {
    pub now: i64,
    pub drop_old_text: bool,
}

fn to_f64(ms: i64) -> Option<f64> {
    Some(ms as f64)
}

/// A note's record, or its tombstone when it is forgotten.
pub fn note_item_in(tx: &dyn Tx, stored: &StoredNote, travel: Travel) -> Result<SyncItem, Error> {
    let note = &stored.note;
    let id = format!("{NOTE_RECORD}{}", note.id);
    if let Some(at) = stored.forgotten_at {
        let fingerprint = tx.mem_book().forgotten(&note.id)?.map(|f| f.fingerprint).unwrap_or_else(|| "{}".into());
        return Ok(tombstone(id, at, &fingerprint));
    }
    let links = tx.mem_graph().links(std::slice::from_ref(&note.id))?;
    let starts: Vec<&StoredLink> = links.iter().filter(|link| link.a == note.id).collect();
    let mut hook_ids: Vec<String> =
        starts.iter().filter(|link| link.rel == "about").map(|link| link.b.clone()).collect();
    hook_ids.extend(note.do_hooks.iter().chain(&note.avoid_hooks).cloned());
    hook_ids.sort();
    hook_ids.dedup();
    let hooks: Vec<Value> = tx
        .mem_graph()
        .hooks(&hook_ids)?
        .into_iter()
        .map(|hook| json!({"id": hook.id, "kind": hook.kind, "key": hook.key, "label": hook.label}))
        .collect();
    let evidence: Vec<Value> = tx
        .mem_evidence()
        .of_note(&note.id, EVIDENCE_SYNCED)?
        .into_iter()
        .map(|e| json!({"id": e.id, "kind": e.kind, "summary": e.summary, "runId": e.run_id, "at": e.at, "device": e.device}))
        .collect();
    let versions = tx.mem_versions().of_note(&note.id)?.len();
    let old = note.kind == NoteKind::Episode
        && note.state == NoteState::Closed
        && travel.now - note.updated_at > OLD_EPISODE_MS;
    let (text, body) = if travel.drop_old_text && old {
        (String::new(), json!({}))
    } else {
        (note.text.clone(), serde_json::to_value(&note.body).map_err(Error::storage)?)
    };
    let data = json!({
        "kind": note.kind.as_str(),
        "text": text,
        "body": body,
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
        "hooks": hooks,
        "links": starts.iter().filter(|l| l.rel != "about").map(|l| json!({"b": l.b, "rel": l.rel})).collect::<Vec<_>>(),
        "evidence": evidence,
        "versions": versions,
    });
    Ok(SyncItem { id, data, updated_at: to_f64(note.updated_at) })
}

fn tombstone(id: String, at: i64, fingerprint: &str) -> SyncItem {
    let fingerprint = serde_json::to_value(crate::forget::fingerprint_of(fingerprint)).unwrap_or(Value::Null);
    SyncItem { id, data: json!({"forgotten": true, "at": at, "fingerprint": fingerprint}), updated_at: to_f64(at) }
}

/// The tombstones of forgotten notes whose row is gone already.
fn bare_tombstones_in(tx: &dyn Tx, since: i64) -> Result<Vec<SyncItem>, Error> {
    let mut items = Vec::new();
    for forgotten in tx.mem_book().forgotten_since(since)? {
        if tx.mem_notes().find(&forgotten.note_id)?.is_none() {
            items.push(tombstone(format!("{NOTE_RECORD}{}", forgotten.note_id), forgotten.at, &forgotten.fingerprint));
        }
    }
    Ok(items)
}

/// Every note's record changed after `since` (all of them from 0), with the
/// tombstones of notes forgotten since then.
pub fn note_items_in(tx: &dyn Tx, since: i64, travel: Travel) -> Result<Vec<SyncItem>, Error> {
    let mut items = Vec::new();
    for stored in tx.mem_notes().changed_since(since.saturating_sub(1))? {
        items.push(note_item_in(tx, &stored, travel)?);
    }
    for forgotten in tx.mem_book().forgotten_since(since)? {
        if let Some(stored) = tx.mem_notes().find(&forgotten.note_id)?
            && stored.note.updated_at < since
        {
            items.push(note_item_in(tx, &stored, travel)?);
        }
    }
    items.extend(bare_tombstones_in(tx, since)?);
    Ok(items)
}

/// The ids of every note record: notes and the forgotten ones whose row is gone.
pub fn note_ids_in(tx: &dyn Tx) -> Result<Vec<String>, Error> {
    let mut ids: Vec<String> = tx.mem_notes().ids()?.into_iter().map(|id| format!("{NOTE_RECORD}{id}")).collect();
    ids.extend(bare_tombstones_in(tx, 0)?.into_iter().map(|item| item.id));
    Ok(ids)
}

/// `device`'s counters, a record per shard.
pub fn counter_items_in(tx: &dyn Tx, device: &str) -> Result<Vec<SyncItem>, Error> {
    let mut shards: BTreeMap<String, (Map<String, Value>, i64)> = BTreeMap::new();
    for credit in tx.mem_credit().of_device(device)? {
        let (counters, newest) = shards.entry(shard(&credit.note_id)).or_default();
        let c = credit.counters;
        counters.insert(
            credit.note_id.clone(),
            json!({"helped": c.helped, "hurt": c.hurt, "used": c.used, "lastUsedAt": c.last_used_at}),
        );
        *newest = (*newest).max(c.last_used_at.unwrap_or_default());
    }
    Ok(shards
        .into_iter()
        .map(|(shard, (counters, newest))| SyncItem {
            id: counter_record(device, &shard),
            data: json!({"device": device, "counters": counters}),
            updated_at: to_f64(newest),
        })
        .collect())
}

/// One record as this Mac holds it now.
pub fn item_in(tx: &dyn Tx, device: &str, id: &str, travel: Travel) -> Result<Option<SyncItem>, Error> {
    if let Some(note_id) = id.strip_prefix(NOTE_RECORD) {
        if let Some(stored) = tx.mem_notes().find(note_id)? {
            return note_item_in(tx, &stored, travel).map(Some);
        }
        return Ok(tx.mem_book().forgotten(note_id)?.map(|f| tombstone(id.to_owned(), f.at, &f.fingerprint)));
    }
    Ok(counter_items_in(tx, device)?.into_iter().find(|item| item.id == id))
}

fn refused(what: &str) -> Error {
    Error::Validation(format!("a memory record {what}"))
}

fn text<'a>(data: &'a Value, key: &str) -> Result<&'a str, Error> {
    data[key].as_str().ok_or_else(|| refused(&format!("needs {key}")))
}

fn strings(data: &Value, key: &str) -> Vec<String> {
    data[key].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

/// The note a record holds.
fn note_of(note_id: &str, data: &Value) -> Result<Note, Error> {
    let parse_err = |what: &str| refused(&format!("has an unknown {what}"));
    Ok(Note {
        id: note_id.to_owned(),
        kind: NoteKind::parse(text(data, "kind")?).ok_or_else(|| parse_err("kind"))?,
        text: text(data, "text")?.to_owned(),
        body: serde_json::from_value::<NoteBody>(data["body"].clone()).unwrap_or(NoteBody::None {}),
        trust: Trust::parse(text(data, "trust")?).ok_or_else(|| parse_err("trust"))?,
        state: NoteState::parse(text(data, "state")?).ok_or_else(|| parse_err("state"))?,
        scope: Scope {
            level: ScopeLevel::parse(data["scope"]["level"].as_str().unwrap_or_default())
                .ok_or_else(|| parse_err("scope"))?,
            key: data["scope"]["key"].as_str().unwrap_or_default().to_owned(),
        },
        valid_from: data["validFrom"].as_i64().unwrap_or_default(),
        valid_to: data["validTo"].as_i64(),
        replaced_by: data["replacedBy"].as_str().map(str::to_owned),
        do_hooks: strings(data, "do"),
        avoid_hooks: strings(data, "avoid"),
        created_at: data["createdAt"].as_i64().unwrap_or_default(),
        updated_at: data["updatedAt"].as_i64().unwrap_or_default(),
        device: text(data, "device")?.to_owned(),
    })
}

/// Takes in another Mac's record inside the caller's write job. This Mac's
/// own counters are never taken back.
pub fn apply_in(tx: &dyn Tx, out: &mut Outbox, device: &str, id: &str, data: &Value) -> Result<(), Error> {
    if let Some(note_id) = id.strip_prefix(NOTE_RECORD) {
        if data["forgotten"].as_bool() == Some(true) {
            return forgotten_in(tx, out, note_id, data);
        }
        return note_in(tx, out, note_id, data);
    }
    let Some(rest) = id.strip_prefix(COUNTER_RECORD) else { return Err(refused("has an unknown id")) };
    let from = data["device"].as_str().unwrap_or_default();
    if from == device || !rest.starts_with(from) {
        return Ok(());
    }
    for (note_id, c) in data["counters"].as_object().into_iter().flatten() {
        let counters = Counters {
            helped: c["helped"].as_i64().unwrap_or_default(),
            hurt: c["hurt"].as_i64().unwrap_or_default(),
            used: c["used"].as_i64().unwrap_or_default(),
            last_used_at: c["lastUsedAt"].as_i64(),
        };
        tx.mem_credit().put(&StoredCredit { note_id: note_id.clone(), device: from.to_owned(), counters })?;
    }
    Ok(())
}

fn note_in(tx: &dyn Tx, out: &mut Outbox, note_id: &str, data: &Value) -> Result<(), Error> {
    let note = note_of(note_id, data)?;
    let hooks: Vec<StoredHook> = data["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hook| {
            Some(StoredHook {
                id: hook["id"].as_str()?.to_owned(),
                kind: serde_json::from_value::<HookKind>(hook["kind"].clone()).ok()?,
                key: hook["key"].as_str()?.to_owned(),
                label: hook["label"].as_str().unwrap_or_default().to_owned(),
                degree: 0,
            })
        })
        .collect();
    let cues = hooks.iter().map(|hook| hook.key.as_str()).collect::<Vec<_>>().join(" ");
    match tx.mem_notes().find(note_id)? {
        // A text dropped for the vault's room never replaces this Mac's own.
        Some(_) if note.text.is_empty() => {}
        Some(old) => tx.mem_notes().update(&note, &cues, old.rev + 1)?,
        None if tx.mem_book().forgotten(note_id)?.is_some() => return Ok(()),
        None => {
            tx.mem_notes().insert(&note, &cues)?;
        }
    }
    let mut hook_ids = Vec::new();
    for hook in &hooks {
        tx.mem_graph().add_hook(hook)?;
        let about = StoredLink {
            a: note_id.to_owned(),
            b: hook.id.clone(),
            rel: "about".into(),
            weight: 1.0,
            co_uses: 0,
            updated_at: note.updated_at,
        };
        tx.mem_graph().put_link(&about)?;
        hook_ids.push(hook.id.clone());
    }
    tx.mem_graph().recount_degrees(&hook_ids)?;
    for link in data["links"].as_array().into_iter().flatten() {
        let (Some(b), Some(rel)) = (link["b"].as_str(), link["rel"].as_str()) else { continue };
        let link = StoredLink {
            a: note_id.to_owned(),
            b: b.to_owned(),
            rel: rel.to_owned(),
            weight: 1.0,
            co_uses: 0,
            updated_at: note.updated_at,
        };
        tx.mem_graph().put_link(&link)?;
    }
    let known: Vec<String> = tx.mem_evidence().of_note(note_id, i64::MAX)?.into_iter().map(|e| e.id).collect();
    for e in data["evidence"].as_array().into_iter().flatten() {
        let Some(id) = e["id"].as_str().filter(|id| !known.iter().any(|k| k == id)) else { continue };
        tx.mem_evidence().insert(&StoredEvidence {
            id: id.to_owned(),
            note_id: note_id.to_owned(),
            kind: e["kind"].as_str().unwrap_or_default().to_owned(),
            summary: e["summary"].as_str().unwrap_or_default().to_owned(),
            worker_id: None,
            row_from: None,
            row_to: None,
            run_id: e["runId"].as_str().map(str::to_owned),
            at: e["at"].as_i64().unwrap_or_default(),
            device: e["device"].as_str().unwrap_or_default().to_owned(),
        })?;
    }
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![note_id.to_owned()], action: SYNCED.into() });
    Ok(())
}

/// Another Mac forgot the note: this one forgets it too, and keeps its
/// fingerprint so it is not learned again.
fn forgotten_in(tx: &dyn Tx, out: &mut Outbox, note_id: &str, data: &Value) -> Result<(), Error> {
    let at = data["at"].as_i64().unwrap_or_default();
    if tx.mem_book().forgotten(note_id)?.is_some() {
        return Ok(());
    }
    let stored = tx.mem_notes().find(note_id)?;
    let snapshot = stored.as_ref().map_or_else(|| "{}".to_owned(), |s| crate::forget::snapshot(&s.note).to_string());
    tx.mem_book().put_forgotten(&StoredForgotten {
        note_id: note_id.to_owned(),
        fingerprint: serde_json::to_string(&crate::forget::fingerprint_of(&data["fingerprint"].to_string()))
            .unwrap_or_else(|_| "{}".into()),
        snapshot,
        at,
    })?;
    if stored.is_some() {
        tx.mem_notes().set_forgotten(note_id, Some(at))?;
    }
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![note_id.to_owned()], action: SYNCED.into() });
    Ok(())
}

/// The record went from the vault: a note's row and its forgotten record
/// go; another Mac's counters stay as last heard.
pub fn remove_in(tx: &dyn Tx, out: &mut Outbox, id: &str) -> Result<(), Error> {
    let Some(note_id) = id.strip_prefix(NOTE_RECORD) else { return Ok(()) };
    tx.mem_notes().delete(note_id)?;
    tx.mem_book().remove_forgotten(note_id)?;
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![note_id.to_owned()], action: SYNCED.into() });
    Ok(())
}

/// One note record from two Macs that both changed it: a forgotten side
/// wins, else the newer text (the device breaks a tie) with the union of
/// both sides' evidence (the newest kept) and links. Counters never merge:
/// each Mac writes only its own.
pub fn merge(local: &Value, remote: &Value) -> Option<Value> {
    if local.get("counters").is_some() || remote.get("counters").is_some() {
        return None;
    }
    let forgotten = |v: &Value| v["forgotten"].as_bool() == Some(true);
    match (forgotten(local), forgotten(remote)) {
        (true, true) => return Some(if remote["at"].as_i64() > local["at"].as_i64() { remote } else { local }.clone()),
        (true, false) => return Some(local.clone()),
        (false, true) => return Some(remote.clone()),
        (false, false) => {}
    }
    let key =
        |v: &Value| (v["updatedAt"].as_i64().unwrap_or_default(), v["device"].as_str().unwrap_or_default().to_owned());
    let (newer, older) = if key(remote) > key(local) { (remote, local) } else { (local, remote) };
    let mut merged = newer.clone();
    let mut evidence: Vec<Value> = Vec::new();
    for e in newer["evidence"].as_array().into_iter().chain(older["evidence"].as_array()).flatten() {
        if !evidence.iter().any(|kept| kept["id"] == e["id"]) {
            evidence.push(e.clone());
        }
    }
    evidence.sort_by_key(|e| std::cmp::Reverse(e["at"].as_i64().unwrap_or_default()));
    evidence.truncate(EVIDENCE_SYNCED as usize);
    merged["evidence"] = Value::Array(evidence);
    for list in ["links", "hooks"] {
        let mut union: Vec<Value> = newer[list].as_array().cloned().unwrap_or_default();
        for item in older[list].as_array().into_iter().flatten() {
            if !union.contains(item) {
                union.push(item.clone());
            }
        }
        merged[list] = Value::Array(union);
    }
    Some(merged)
}
