//! Notes as the Memory screen shows them.

use std::collections::HashMap;

use eos_contracts::{ExperienceNoteRow, ExperienceScope};
use eos_core::Error;
use eos_core::git::ProjectKeys;
use eos_core::store::{StoredNote, Tx};
use eos_domain::experience::{Scope, ScopeLevel};

/// The oldest evidence of each note: what first taught it.
pub(crate) type FirstEvidence = HashMap<String, (String, String)>;

/// What first taught each of `notes`: `(signal, summary)`.
pub(crate) fn first_evidence_in(tx: &dyn Tx, notes: &[StoredNote]) -> Result<FirstEvidence, Error> {
    let mut first = HashMap::new();
    for stored in notes {
        let evidence = tx.mem_evidence().of_note(&stored.note.id, eos_core::store::MEM_EVIDENCE_PER_NOTE)?;
        if let Some(oldest) = evidence.last() {
            first.insert(stored.note.id.clone(), (oldest.kind.clone(), oldest.summary.clone()));
        }
    }
    Ok(first)
}

/// Each project key's folder name, as scopes show it.
pub(crate) async fn labels(keys: &dyn ProjectKeys, scopes: Vec<Scope>) -> HashMap<String, String> {
    let mut labels = HashMap::new();
    for scope in &scopes {
        if scope.level != ScopeLevel::Project || labels.contains_key(&scope.key) {
            continue;
        }
        let label = match keys.find_path(&scope.key).await {
            Some(path) => path.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_owned(),
            None => scope.key.clone(),
        };
        labels.insert(scope.key.clone(), label);
    }
    labels
}

pub(crate) fn scope(scope: &Scope, labels: &HashMap<String, String>) -> ExperienceScope {
    let label = match scope.level {
        ScopeLevel::Project => labels.get(&scope.key).cloned().unwrap_or_else(|| scope.key.clone()),
        _ => scope.key.clone(),
    };
    ExperienceScope { level: scope.level.as_str().to_owned(), key: scope.key.clone(), label }
}

pub(crate) fn row(stored: &StoredNote, first: &FirstEvidence, labels: &HashMap<String, String>) -> ExperienceNoteRow {
    let note = &stored.note;
    let (source, why) = first.get(&note.id).cloned().unwrap_or_default();
    ExperienceNoteRow {
        id: note.id.clone(),
        kind: note.kind.as_str().to_owned(),
        text: note.text.clone(),
        why,
        source,
        state: note.state.as_str().to_owned(),
        trust: note.trust.as_str().to_owned(),
        helped: stored.counters.helped,
        used: stored.counters.used,
        scope: scope(&note.scope, labels),
        rev: stored.rev,
        forgotten_at: stored.forgotten_at,
        updated_at: note.updated_at,
    }
}
