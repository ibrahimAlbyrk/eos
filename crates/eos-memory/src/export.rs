//! "Export" (04 G37): every live note with its evidence summaries, in one
//! document the user saves. Forgotten, closed and replaced notes are left out.

use eos_contracts::{ExperienceExport, ExperienceExportEvidence, ExperienceExportNote};
use eos_core::Error;
use eos_core::store::{MEM_EVIDENCE_PER_NOTE, Tx};

pub fn export_in(tx: &dyn Tx, now: i64) -> Result<ExperienceExport, Error> {
    let mut notes = Vec::new();
    for stored in tx.mem_notes().changed_since(i64::MIN)? {
        let note = &stored.note;
        if stored.forgotten_at.is_some() || !note.live(now) {
            continue;
        }
        let evidence = tx
            .mem_evidence()
            .of_note(&note.id, MEM_EVIDENCE_PER_NOTE)?
            .into_iter()
            .map(|e| ExperienceExportEvidence { kind: e.kind, summary: e.summary, at: e.at })
            .collect();
        let scope = match note.scope.key.as_str() {
            "" => note.scope.level.as_str().to_owned(),
            key => format!("{}:{key}", note.scope.level.as_str()),
        };
        notes.push(ExperienceExportNote {
            id: note.id.clone(),
            kind: note.kind.as_str().to_owned(),
            text: note.text.clone(),
            trust: note.trust.as_str().to_owned(),
            state: note.state.as_str().to_owned(),
            scope,
            created_at: note.created_at,
            updated_at: note.updated_at,
            evidence,
        });
    }
    Ok(ExperienceExport { exported_at: now, notes })
}
