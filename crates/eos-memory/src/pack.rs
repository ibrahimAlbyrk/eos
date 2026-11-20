//! Packs: the notes that go in front of the model at the start of each
//! epoch of a chat, within their own budget beside the profile.

use eos_domain::experience::budget::{CHAT_PACK_TOKENS, Line, fit};
use eos_domain::experience::rank::PACK_THRESHOLD;
use eos_domain::experience::render::{PACK_HEADER, Rendered, note_block};
use eos_domain::text::estimate_tokens;

use crate::recall::Recalled;

/// A block of notes for the model and what it holds.
#[derive(Debug, Clone, PartialEq)]
pub struct Pack {
    pub text: String,
    pub note_ids: Vec<String>,
    pub tokens: i64,
}

/// The size a note takes in a pack: its line as rendered.
fn line_tokens(recalled: &Recalled) -> i64 {
    // "- [hint] " before the text, " (mn-…)" after it.
    estimate_tokens(&recalled.note.note.text) + 8
}

/// A chat's pack from `recalled` (best first): notes past the pack's bar,
/// as many as fit. `None` when no note qualifies: nothing is sent.
pub fn chat_pack(recalled: &[Recalled]) -> Option<Pack> {
    let eligible: Vec<&Recalled> = recalled.iter().filter(|r| r.score >= PACK_THRESHOLD).collect();
    let lines: Vec<Line> = eligible.iter().map(|r| Line { tokens: line_tokens(r), pinned: false }).collect();
    let kept: Vec<&Recalled> = fit(&lines, CHAT_PACK_TOKENS).into_iter().map(|i| eligible[i]).collect();
    if kept.is_empty() {
        return None;
    }
    let rendered: Vec<Rendered<'_>> = kept
        .iter()
        .map(|r| Rendered {
            id: &r.note.note.id,
            text: &r.note.note.text,
            state: r.note.note.state,
            trust: r.note.note.trust,
        })
        .collect();
    let text = note_block(PACK_HEADER, &rendered);
    let tokens = estimate_tokens(&text);
    Some(Pack { text, note_ids: kept.iter().map(|r| r.note.note.id.clone()).collect(), tokens })
}
