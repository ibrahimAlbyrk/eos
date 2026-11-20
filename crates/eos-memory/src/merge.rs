//! Merge: what a reflection learned, written in one job. A new note comes
//! with its hooks, its links, its first version and its evidence; a known
//! lesson gains evidence; a replaced note is closed. The moment is marked
//! reflected in the same job, and `memory:change` leaves after commit.

use eos_contracts::ExperienceChange;
use eos_core::store::{StoredEvidence, StoredHook, StoredLink, StoredMoment, StoredNoteVersion, Tx};
use eos_core::{Error, Ids};
use eos_domain::experience::merge::MergePlan;
use eos_domain::experience::reflect::Draft;
use eos_domain::experience::{Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, hook_id, state};

/// Topic of notes learned, changed, forgotten, or their counts moved.
pub const MEMORY_CHANGE: &str = "memory:change";

/// Where the moment was: what a note's scope is keyed by.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Place {
    pub routine: Option<String>,
    pub project: Option<String>,
}

/// The scope a draft asks for at `place`: a level whose key is unknown
/// there widens to the next one known.
pub fn scope_at(level: ScopeLevel, work_kind: Option<&str>, place: &Place) -> Scope {
    let routine = place.routine.as_ref().map(|k| Scope { level: ScopeLevel::Routine, key: k.clone() });
    let project = place.project.as_ref().map(|k| Scope { level: ScopeLevel::Project, key: k.clone() });
    let work = work_kind.map(|k| Scope { level: ScopeLevel::Work, key: k.to_owned() });
    let chain = match level {
        ScopeLevel::Routine => vec![routine, project, work],
        ScopeLevel::Project => vec![project, work],
        ScopeLevel::Work => vec![work],
        ScopeLevel::Everywhere => vec![],
    };
    chain.into_iter().flatten().next().unwrap_or_else(Scope::everywhere)
}

fn body_of(draft: &Draft) -> NoteBody {
    match draft.kind {
        NoteKind::Skill => NoteBody::Skill { situation: draft.situation.clone(), steps: Vec::new() },
        NoteKind::Lesson => NoteBody::Lesson {
            situation: draft.situation.clone(),
            wrong: draft.wrong.clone(),
            instead: draft.instead.clone(),
        },
        _ => NoteBody::None {},
    }
}

fn evidence(
    ids: &dyn Ids,
    note_id: &str,
    moment: &StoredMoment,
    summary: &str,
    device: &str,
    at: i64,
) -> StoredEvidence {
    StoredEvidence {
        id: ids.memory_row_id(),
        note_id: note_id.to_owned(),
        kind: moment.signal.clone(),
        summary: summary.to_owned(),
        worker_id: Some(moment.worker_id.clone()),
        row_from: Some(moment.row_from),
        row_to: Some(moment.row_to),
        run_id: moment.run_id.clone(),
        at,
        device: device.to_owned(),
    }
}

/// What one merge wrote: the note it learned or gained evidence for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub note_id: String,
    pub new: bool,
}

/// Writes `draft` by `plan` for `moment`, inside the caller's write job.
#[allow(clippy::too_many_arguments)]
pub fn merge_in(
    tx: &dyn Tx,
    out: &mut eos_core::store::Outbox,
    ids: &dyn Ids,
    moment: &StoredMoment,
    draft: &Draft,
    plan: &MergePlan,
    place: &Place,
    device: &str,
    now: i64,
) -> Result<Merged, Error> {
    if let MergePlan::AddEvidence(id) = plan
        && tx.mem_notes().find(id)?.is_some_and(|n| n.forgotten_at.is_none())
    {
        tx.mem_evidence().insert(&evidence(ids, id, moment, &draft.evidence, device, now))?;
        tx.mem_moments().finish(&moment.id, "reflected", Some(id), now)?;
        out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![id.clone()], action: "changed".into() });
        return Ok(Merged { note_id: id.clone(), new: false });
    }
    let (links, close) = match plan {
        MergePlan::Insert { links, close } => (links.clone(), close.clone()),
        MergePlan::AddEvidence(_) => (Vec::new(), Vec::new()),
    };
    let id = ids.note_id();
    let hook_of = |key: &str| draft.hooks.iter().find(|h| h.key == key).map(|h| hook_id(h.kind, &h.key));
    let note = Note {
        id: id.clone(),
        kind: draft.kind,
        text: draft.text.clone(),
        body: body_of(draft),
        trust: draft.trust,
        state: state::initial(draft.trust),
        scope: scope_at(draft.scope, draft.work_kind.as_deref(), place),
        valid_from: now,
        valid_to: draft.valid_for.map(|ms| now + ms),
        replaced_by: None,
        do_hooks: draft.do_keys.iter().filter_map(|k| hook_of(k)).collect(),
        avoid_hooks: draft.avoid_keys.iter().filter_map(|k| hook_of(k)).collect(),
        created_at: now,
        updated_at: now,
        device: device.to_owned(),
    };
    let cues = draft.hooks.iter().map(|h| h.key.as_str()).collect::<Vec<_>>().join(" ");
    tx.mem_notes().insert(&note, &cues)?;
    let mut hook_ids = Vec::new();
    for hook in &draft.hooks {
        let hid = hook_id(hook.kind, &hook.key);
        tx.mem_graph().add_hook(&StoredHook {
            id: hid.clone(),
            kind: hook.kind,
            key: hook.key.clone(),
            label: String::new(),
            degree: 0,
        })?;
        let about =
            StoredLink { a: id.clone(), b: hid.clone(), rel: "about".into(), weight: 1.0, co_uses: 0, updated_at: now };
        tx.mem_graph().put_link(&about)?;
        hook_ids.push(hid);
    }
    tx.mem_graph().recount_degrees(&hook_ids)?;
    for (from, to, rel) in links {
        let a = from.unwrap_or_else(|| id.clone());
        let b = to.unwrap_or_else(|| id.clone());
        tx.mem_graph().put_link(&StoredLink { a, b, rel: rel.into(), weight: 1.0, co_uses: 0, updated_at: now })?;
    }
    let mut changed = Vec::new();
    for old_id in close {
        let Some(old) = tx.mem_notes().find(&old_id)? else { continue };
        let mut closed = old.note.clone();
        closed.state = NoteState::Closed;
        closed.replaced_by = Some(id.clone());
        closed.updated_at = now.max(old.note.updated_at);
        closed.device = device.to_owned();
        tx.mem_notes().update(&closed, &old.cues, old.rev + 1)?;
        tx.mem_versions().insert(&version(&closed, old.rev + 1, "merged", now))?;
        changed.push(old_id);
    }
    tx.mem_versions().insert(&version(&note, 1, "learned", now))?;
    tx.mem_evidence().insert(&evidence(ids, &id, moment, &draft.evidence, device, now))?;
    tx.mem_moments().finish(&moment.id, "reflected", Some(&id), now)?;
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![id.clone()], action: "learned".into() });
    if !changed.is_empty() {
        out.push(MEMORY_CHANGE, &ExperienceChange { ids: changed, action: "changed".into() });
    }
    Ok(Merged { note_id: id, new: true })
}

/// A note as it stands at `rev`, kept in its history.
pub fn version(note: &Note, rev: i64, why: &str, at: i64) -> StoredNoteVersion {
    StoredNoteVersion {
        note_id: note.id.clone(),
        rev,
        text: note.text.clone(),
        body: serde_json::to_string(&note.body).unwrap_or_else(|_| "{}".to_owned()),
        scope_level: note.scope.level,
        scope_key: note.scope.key.clone(),
        state: note.state,
        why: why.to_owned(),
        at,
    }
}
