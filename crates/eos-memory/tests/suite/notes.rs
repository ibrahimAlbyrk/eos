//! Notes written straight into the store, as the merge step will write them.

use eos_core::store::{StoredHook, StoredLink};
use eos_domain::experience::cues::Cue;
use eos_domain::experience::{HookKind, Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust, hook_id};
use eos_testkit::{FakeClock, TempStore};

pub(crate) fn note(id: &str, text: &str, scope: Scope) -> Note {
    Note {
        id: id.into(),
        kind: NoteKind::Lesson,
        text: text.into(),
        body: NoteBody::None {},
        trust: Trust::Did,
        state: NoteState::Firm,
        scope,
        valid_from: 0,
        valid_to: None,
        replaced_by: None,
        do_hooks: vec![],
        avoid_hooks: vec![],
        created_at: FakeClock::START_MS - 1_000,
        updated_at: FakeClock::START_MS - 1_000,
        device: "mac-a".into(),
    }
}

pub(crate) fn project(key: &str) -> Scope {
    Scope { level: ScopeLevel::Project, key: key.into() }
}

pub(crate) fn routine(key: &str) -> Scope {
    Scope { level: ScopeLevel::Routine, key: key.into() }
}

pub(crate) fn cue(kind: HookKind, key: &str) -> Cue {
    Cue { kind, key: key.into() }
}

pub(crate) fn link(a: &str, b: &str, rel: &str) -> StoredLink {
    StoredLink { a: a.into(), b: b.into(), rel: rel.into(), weight: 1.0, co_uses: 0, updated_at: 0 }
}

/// Writes `note` about `hooks`.
pub(crate) fn put(temp: &TempStore, note: Note, hooks: &[Cue]) {
    let hooks = hooks.to_vec();
    temp.store
        .write_blocking(move |tx, _| {
            let cues = hooks.iter().map(|h| h.key.as_str()).collect::<Vec<_>>().join(" ");
            tx.mem_notes().insert(&note, &cues)?;
            for hook in &hooks {
                let id = hook_id(hook.kind, &hook.key);
                tx.mem_graph().add_hook(&StoredHook {
                    id: id.clone(),
                    kind: hook.kind,
                    key: hook.key.clone(),
                    label: String::new(),
                    degree: 0,
                })?;
                tx.mem_graph().put_link(&link(&note.id, &id, "about"))?;
            }
            Ok(())
        })
        .expect("writes");
}
