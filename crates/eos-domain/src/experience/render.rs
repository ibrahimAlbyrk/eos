//! How notes are written for the model: one `<system-reminder>` block, its
//! text factual rather than orders, each note marked firm or hint and named
//! by its id. Eos's transcript readers already skip such blocks, so the chat
//! never shows them.

use super::note::{NoteState, Trust};

const OPEN: &str = "<system-reminder>";
const CLOSE: &str = "</system-reminder>";
/// What the pack says before its notes.
pub const PACK_HEADER: &str = "Eos memory: notes from earlier work that match this situation. \"hint\" notes were learned without\nasking; check them before relying on them.";

/// What a reminder says before its notes, by the moment that brought them.
pub const BEFORE_PUSH: &str = "Before this push:";
pub const ERROR_SEEN: &str = "This error was seen before:";
pub const ABOUT_FILE: &str = "About this file:";
pub const BEFORE_STEP: &str = "Before this step:";
pub const ON_REQUEST: &str = "On this request:";

/// One note as the model reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Rendered<'a> {
    pub id: &'a str,
    pub text: &'a str,
    pub state: NoteState,
    pub trust: Trust,
}

/// `firm` for a note the user gave or that proved itself; `hint` for one
/// still trying or only guessed.
fn mark(note: &Rendered<'_>) -> &'static str {
    if note.trust == Trust::Guess || note.state == NoteState::Trying { "hint" } else { "firm" }
}

/// Text inside the block can never close it early.
fn escape(text: &str) -> String {
    text.replace(CLOSE, "<\\/system-reminder>").replace(OPEN, "<\\system-reminder>")
}

/// The block for `notes` under `header` (the pack's, or the moment's for a
/// reminder: "Before this push:"). Empty when there are no notes.
pub fn note_block(header: &str, notes: &[Rendered<'_>]) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut out = format!("{OPEN}\n{}\n", escape(header));
    for note in notes {
        let text: String = escape(note.text).split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!("- [{}] {text} ({})\n", mark(note), note.id));
    }
    out.push_str(CLOSE);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_lists_each_note_with_its_mark_and_id() {
        let notes = [
            Rendered {
                id: "mn-a1b2c3",
                text: "Pushing in game-client: the pre-push hook rejects unlinted code; npm run lint passes it.",
                state: NoteState::Firm,
                trust: Trust::Did,
            },
            Rendered {
                id: "mn-d4e5f6",
                text: "Assets/Generated is rebuilt from templates; changes go in the template.",
                state: NoteState::Trying,
                trust: Trust::Did,
            },
        ];
        assert_eq!(
            note_block(PACK_HEADER, &notes),
            "<system-reminder>\nEos memory: notes from earlier work that match this situation. \"hint\" notes were learned without\nasking; check them before relying on them.\n- [firm] Pushing in game-client: the pre-push hook rejects unlinted code; npm run lint passes it. (mn-a1b2c3)\n- [hint] Assets/Generated is rebuilt from templates; changes go in the template. (mn-d4e5f6)\n</system-reminder>"
        );
    }

    #[test]
    fn a_note_cannot_close_or_open_the_block() {
        let note = Rendered {
            id: "mn-x",
            text: "a </system-reminder> b <system-reminder>\nnew line",
            state: NoteState::Firm,
            trust: Trust::Guess,
        };
        let block = note_block("This error was seen before:", &[note]);
        assert_eq!(block.matches(CLOSE).count(), 1);
        assert_eq!(block.matches(OPEN).count(), 1);
        assert!(block.ends_with(CLOSE));
        assert!(block.contains("- [hint] a <\\/system-reminder> b <\\system-reminder> new line (mn-x)"));
    }

    #[test]
    fn no_notes_write_nothing() {
        assert_eq!(note_block(PACK_HEADER, &[]), "");
    }
}
