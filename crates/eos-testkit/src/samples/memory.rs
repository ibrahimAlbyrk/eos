//! Four notes Eos learned: a lesson from an edited review, a fact the user
//! said, a skill and a guess still on trial from outside text.

use eos_core::Error;
use eos_core::store::Tx;
use eos_domain::experience::{Note, NoteBody, NoteKind, NoteState, Scope, ScopeLevel, Trust};

use super::surfaces::MORNING_MAIL;
use crate::routine_seed::{BASE_MS, DAY, DEVICE, PR_REVIEW};

pub(super) fn write(tx: &dyn Tx) -> Result<(), Error> {
    let routine = |id: &str| Scope { level: ScopeLevel::Routine, key: id.to_owned() };
    let notes = [
        (
            NoteKind::Lesson,
            "Name the line of every review comment.",
            NoteBody::Lesson {
                situation: "Writing a review comment".to_owned(),
                wrong: "A comment that names no line".to_owned(),
                instead: "Cite the file and line".to_owned(),
            },
            Trust::Did,
            NoteState::Firm,
            routine(PR_REVIEW),
            "review comment line",
        ),
        (
            NoteKind::Fact,
            "The team's release branch is release/2.4.",
            NoteBody::None {},
            Trust::Said,
            NoteState::Firm,
            Scope::everywhere(),
            "release branch",
        ),
        (
            NoteKind::Skill,
            "Sum up mail by sender first, then by thread.",
            NoteBody::Skill {
                situation: "Summing up the night's mail".to_owned(),
                steps: vec!["Group by sender".to_owned(), "Merge each thread".to_owned()],
            },
            Trust::Outcome,
            NoteState::Trying,
            routine(MORNING_MAIL),
            "mail digest sender thread",
        ),
        (
            NoteKind::Lesson,
            "Mails from the build server need no reply.",
            NoteBody::None {},
            Trust::Guess,
            NoteState::Trying,
            routine(MORNING_MAIL),
            "build server mail reply",
        ),
    ];
    for (i, (kind, text, body, trust, state, scope, cues)) in notes.into_iter().enumerate() {
        let at = BASE_MS - (4 - i as i64) * DAY;
        let note = Note {
            id: format!("mn-5a3b1e0000{:02}", i + 1),
            kind,
            text: text.to_owned(),
            body,
            trust,
            state,
            scope,
            valid_from: at,
            valid_to: None,
            replaced_by: None,
            do_hooks: vec![],
            avoid_hooks: vec![],
            created_at: at,
            updated_at: at,
            device: DEVICE.to_owned(),
        };
        tx.mem_notes().insert(&note, cues)?;
    }
    Ok(())
}
