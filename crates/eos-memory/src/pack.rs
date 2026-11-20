//! Packs: the notes that go in front of the model at the start of each
//! epoch of a chat, within their own budget beside the profile, and the
//! pack a routine's run reads with its brief.

use eos_core::experience::RunPack;
use eos_domain::experience::budget::{CHAT_PACK_TOKENS, Line, RunOffer, fit, fit_run};
use eos_domain::experience::rank::PACK_THRESHOLD;
use eos_domain::experience::render::{PACK_HEADER, Rendered, note_block};
use eos_domain::experience::{NoteKind, ScopeLevel, Trust};
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

/// Whether a note is a rule the user stated for this routine: never cut.
fn pinned(recalled: &Recalled, routine_id: &str) -> bool {
    let note = &recalled.note.note;
    note.trust == Trust::Said && note.scope.level == ScopeLevel::Routine && note.scope.key == routine_id
}

/// A routine run's pack from `recalled` (best first): its playbook, the
/// notes recalled for the item and good examples, each part within its own
/// budget and the whole within the run's (04 G3). `None` when no note
/// qualifies.
pub fn run_pack(recalled: &[Recalled], routine_id: &str) -> Option<RunPack> {
    let eligible: Vec<&Recalled> =
        recalled.iter().filter(|r| r.score >= PACK_THRESHOLD || pinned(r, routine_id)).collect();
    let part = |wanted: &dyn Fn(NoteKind) -> bool| -> Vec<&Recalled> {
        eligible.iter().copied().filter(|r| wanted(r.note.note.kind)).collect()
    };
    let playbook = part(&|k| k == NoteKind::Playbook);
    let examples = part(&|k| k == NoteKind::Example);
    let notes = part(&|k| k != NoteKind::Playbook && k != NoteKind::Example);
    let lines = |part: &[&Recalled]| -> Vec<Line> {
        part.iter().map(|r| Line { tokens: line_tokens(r), pinned: pinned(r, routine_id) }).collect()
    };
    let offer = RunOffer { playbook: lines(&playbook), recalled: lines(&notes), examples: lines(&examples) };
    let pick = fit_run(&offer);
    let take =
        |part: &[&Recalled], kept: &[usize]| -> Vec<Recalled> { kept.iter().map(|&i| part[i].clone()).collect() };
    let chosen_examples = take(&examples, &pick.examples);
    let chosen: Vec<Recalled> = take(&playbook, &pick.playbook)
        .into_iter()
        .chain(take(&notes, &pick.recalled))
        .chain(chosen_examples.iter().cloned())
        .collect();
    if chosen.is_empty() {
        return None;
    }
    let rendered: Vec<Rendered<'_>> = chosen
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
    Some(RunPack {
        text,
        note_ids: chosen.iter().map(|r| r.note.note.id.clone()).collect(),
        example_ids: chosen_examples.iter().map(|r| r.note.note.id.clone()).collect(),
        tokens,
    })
}
