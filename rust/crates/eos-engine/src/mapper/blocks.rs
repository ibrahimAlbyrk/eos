//! The blocks of the response being streamed: live text out, one recorded
//! message per finished block.

use eos_agent_core::BlockKind;
use eos_contracts::{AgentEvent, DeltaEvent, DeltaEventChannel, DeltaEventPhase};
use eos_core::agent::{ToolInputDelta, ToolInputPhase};

use super::Side;
use super::convert::{assistant, reasoning_block, text, text_block};

/// A followed tool's input arrives a few characters at a time, thousands of
/// pieces per call. Pieces are merged until this long passed since the last
/// one sent (or this much is held), so the stream costs tens of frames. No
/// timer: the next piece or the block's end sends what is held.
const INPUT_FLUSH_MS: i64 = 80;
const INPUT_FLUSH_CHARS: usize = 4096;

enum Kind {
    Text,
    Reasoning,
    Tool { call_id: String },
    Other,
}

struct Followed {
    name: String,
    held: String,
    sent_at: i64,
}

struct Open {
    index: u32,
    id: String,
    kind: Kind,
    /// What streamed so far (text and reasoning only).
    text: String,
    /// A `delta start` went out: set on the first piece that has text.
    live: bool,
    followed: Option<Followed>,
}

impl Open {
    fn delta(&self, phase: DeltaEventPhase, text: String) -> AgentEvent {
        let channel =
            if matches!(self.kind, Kind::Reasoning) { DeltaEventChannel::Reasoning } else { DeltaEventChannel::Text };
        AgentEvent::Delta(DeltaEvent { channel, phase, block_id: self.id.clone(), text })
    }

    fn flush_input(&mut self, side: &Side<'_>) {
        let Kind::Tool { call_id } = &self.kind else { return };
        let Some(followed) = &mut self.followed else { return };
        if followed.held.is_empty() {
            return;
        }
        let held = std::mem::take(&mut followed.held);
        followed.sent_at = side.now_ms;
        side.sink
            .tool_input(side.worker_id, ToolInputDelta::new(call_id, &followed.name, ToolInputPhase::Append, held));
    }

    fn end_input(&mut self, side: &Side<'_>) {
        self.flush_input(side);
        if let (Kind::Tool { call_id }, Some(followed)) = (&self.kind, self.followed.take()) {
            let stop = ToolInputDelta::new(call_id, &followed.name, ToolInputPhase::Stop, String::new());
            side.sink.tool_input(side.worker_id, stop);
        }
    }
}

/// Blocks never overlap, so this holds one block almost always.
#[derive(Default)]
pub(super) struct OpenBlocks(Vec<Open>);

impl OpenBlocks {
    pub(super) fn start(&mut self, id: String, index: u32, block: BlockKind, followed: bool, side: &Side<'_>) {
        let (kind, followed) = match block {
            BlockKind::Text => (Kind::Text, None),
            BlockKind::Thinking => (Kind::Reasoning, None),
            BlockKind::ToolUse { id: call_id, name } => {
                let followed = followed.then(|| {
                    let start = ToolInputDelta::new(&call_id, &name, ToolInputPhase::Start, String::new());
                    side.sink.tool_input(side.worker_id, start);
                    Followed { name, held: String::new(), sent_at: i64::MIN }
                });
                (Kind::Tool { call_id }, followed)
            }
            BlockKind::ServerToolUse { .. } | BlockKind::Other(_) => (Kind::Other, None),
        };
        self.0.push(Open { index, id, kind, text: String::new(), live: false, followed });
    }

    /// A piece of text or reasoning for the block opened last. The live
    /// block opens with its first piece that has text.
    pub(super) fn text(&mut self, piece: String, reasoning: bool) -> Option<AgentEvent> {
        let open = self.0.last_mut()?;
        if matches!(open.kind, Kind::Reasoning) != reasoning || matches!(open.kind, Kind::Tool { .. } | Kind::Other) {
            return None;
        }
        if !open.live && piece.is_empty() {
            return None;
        }
        open.text.push_str(&piece);
        let phase = if open.live { DeltaEventPhase::Append } else { DeltaEventPhase::Start };
        open.live = true;
        Some(open.delta(phase, piece))
    }

    pub(super) fn tool_input(&mut self, call_id: &str, piece: &str, side: &Side<'_>) {
        let found = self.0.iter_mut().find(|o| matches!(&o.kind, Kind::Tool { call_id: id } if id == call_id));
        let Some(open) = found else { return };
        let Some(followed) = &mut open.followed else { return };
        if piece.is_empty() {
            return;
        }
        followed.held.push_str(piece);
        if side.now_ms.saturating_sub(followed.sent_at) >= INPUT_FLUSH_MS || followed.held.len() >= INPUT_FLUSH_CHARS {
            open.flush_input(side);
        }
    }

    /// The block is complete: its live block closes and it is recorded.
    pub(super) fn stop(&mut self, index: u32, side: &Side<'_>) -> Vec<AgentEvent> {
        let Some(pos) = self.0.iter().position(|o| o.index == index) else { return Vec::new() };
        let mut open = self.0.remove(pos);
        open.end_input(side);
        let mut out = Vec::new();
        if open.live {
            out.push(open.delta(DeltaEventPhase::Stop, String::new()));
        }
        match open.kind {
            Kind::Text => out.push(text(open.text, open.id)),
            // Reasoning that is only whitespace is never shown.
            Kind::Reasoning if !open.text.trim().is_empty() => {
                out.push(assistant(vec![reasoning_block(open.text, open.id, false)]));
            }
            // A tool call is recorded when its input is complete (its own event).
            Kind::Reasoning | Kind::Tool { .. } | Kind::Other => {}
        }
        out
    }

    /// The turn ended while these were still streaming: no finished block
    /// will come, so what streamed is recorded under the id its deltas used
    /// (reasoning marked as interrupted) and survives a reload.
    pub(super) fn cut(&mut self, side: &Side<'_>) -> Option<AgentEvent> {
        let mut blocks = Vec::new();
        for mut open in self.0.drain(..) {
            open.end_input(side);
            if !open.live || open.text.trim().is_empty() {
                continue;
            }
            match open.kind {
                Kind::Reasoning => blocks.push(reasoning_block(open.text, open.id, true)),
                Kind::Text => blocks.push(text_block(open.text, open.id)),
                Kind::Tool { .. } | Kind::Other => {}
            }
        }
        (!blocks.is_empty()).then(|| assistant(blocks))
    }

    /// The request is being sent again: what streamed of this attempt is void.
    pub(super) fn abandon(&mut self, side: &Side<'_>) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        for mut open in self.0.drain(..) {
            open.end_input(side);
            if open.live {
                out.push(open.delta(DeltaEventPhase::Stop, String::new()));
            }
        }
        out
    }
}
