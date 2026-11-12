//! The pure decisions of compaction: when an idle worker is due, how much of
//! the conversation the summarizer may read, how it is rendered for it, and
//! what survives of its answer (`core/src/domain/compaction.ts`,
//! `core/src/domain/transcript.ts`).
//!
//! Lengths are UTF-16 units, as in the TypeScript these budgets came from.

use eos_core::agent::TranscriptEntry;
use eos_domain::context::context_pct;

/// Rough characters per token for mixed prose and code; budgets and estimates only.
const CHARS_PER_TOKEN: f64 = 3.5;
/// The share of the summarizer's window the rendered conversation may take;
/// the rest is for the instructions and the summary it writes.
const TRANSCRIPT_WINDOW_SHARE: f64 = 0.6;
const FALLBACK_WINDOW: i64 = 200_000;
const TOOL_INPUT_CHARS: usize = 2000;
const TOOL_RESULT_CHARS: usize = 3000;
const SEPARATOR: &str = "\n\n";

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn estimate_tokens(text: &str) -> i64 {
    (units(text) as f64 / CHARS_PER_TOKEN).ceil() as i64
}

pub fn transcript_char_budget(context_window: Option<i64>) -> usize {
    (context_window.unwrap_or(FALLBACK_WINDOW) as f64 * TRANSCRIPT_WINDOW_SHARE * CHARS_PER_TOKEN).floor() as usize
}

/// An automatic compaction is due when it is enabled and the occupancy is at
/// or over the threshold. An unknown window never triggers.
pub fn is_compaction_due(enabled: bool, threshold: f64, used: i64, limit: Option<i64>) -> bool {
    if !enabled || used <= 0 {
        return false;
    }
    context_pct(used, limit).is_some_and(|pct| pct as f64 >= threshold * 100.0)
}

/// Compacting restarts the session, which ends its running subagents, so a
/// due automatic compaction waits for them — but only until the occupancy
/// reaches `cap`, past which waiting risks running out of context.
pub fn should_defer_compaction(live_subagents: usize, used: i64, limit: Option<i64>, cap: f64) -> bool {
    live_subagents > 0 && context_pct(used, limit).is_some_and(|pct| (pct as f64) < cap * 100.0)
}

/// Every `<tag>…</tag>` of `text`, shortest match first, as `(start, end)` of
/// the whole element and its inner text.
fn elements<'a>(text: &'a str, tag: &str) -> Vec<(usize, usize, &'a str)> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(start) = text[from..].find(&open).map(|i| from + i) {
        let inner = start + open.len();
        let Some(end) = text[inner..].find(&close).map(|i| inner + i) else { break };
        found.push((start, end + close.len(), &text[inner..end]));
        from = end + close.len();
    }
    found
}

/// The summary the agent continues from. The summarizer is asked for an
/// `<analysis>` scratchpad and a `<summary>` block; only the last summary is
/// kept. Without a summary block: the whole answer minus any analysis.
pub fn extract_summary(raw: &str) -> String {
    if let Some((_, _, inner)) = elements(raw, "summary").last() {
        return eos_domain::text::js_trim(inner).to_owned();
    }
    let mut rest = String::with_capacity(raw.len());
    let mut from = 0;
    for (start, end, _) in elements(raw, "analysis") {
        rest.push_str(&raw[from..start]);
        from = end;
    }
    rest.push_str(&raw[from..]);
    eos_domain::text::js_trim(&rest).to_owned()
}

/// A conversation as the summarizer reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub text: String,
    /// The user's turns in the conversation (tool results are not turns).
    pub turns: i64,
    /// The oldest entries left out to fit the budget.
    pub omitted: usize,
}

/// `text` cut to `max` UTF-16 units, saying how much is missing.
fn clip(text: &str, max: usize) -> String {
    let total = units(text);
    if total <= max {
        return text.to_owned();
    }
    let mut kept = String::new();
    let mut used = 0;
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > max {
            break;
        }
        kept.push(ch);
    }
    format!("{kept}… [{} more chars]", total - max)
}

fn block(entry: &TranscriptEntry, tool_input_chars: usize) -> String {
    match entry {
        TranscriptEntry::User { text } => format!("[user]\n{text}"),
        TranscriptEntry::Assistant { text } => format!("[assistant]\n{text}"),
        TranscriptEntry::ToolCall { name, input } => format!("[tool call: {name}]\n{}", clip(input, tool_input_chars)),
        TranscriptEntry::ToolResult { text, is_error } => {
            let error = if *is_error { " (error)" } else { "" };
            format!("[tool result{error}]\n{}", clip(text, TOOL_RESULT_CHARS))
        }
    }
}

/// Plain text for the summarizer. Tool input and output are clipped; when it
/// is still over `max_chars` the oldest entries go first — the recent work is
/// what the agent continues — but the first user message always stays, since
/// it usually states the task.
pub fn render_transcript(entries: &[TranscriptEntry], max_chars: usize) -> Rendered {
    render_with(entries, max_chars, TOOL_INPUT_CHARS)
}

fn render_with(entries: &[TranscriptEntry], max_chars: usize, tool_input_chars: usize) -> Rendered {
    let blocks: Vec<String> = entries.iter().map(|e| block(e, tool_input_chars)).collect();
    let turns = entries.iter().filter(|e| matches!(e, TranscriptEntry::User { .. })).count() as i64;
    let size = |blocks: &[String]| blocks.iter().map(|b| units(b) + SEPARATOR.len()).sum::<usize>();
    if size(&blocks) <= max_chars {
        return Rendered { text: blocks.join(SEPARATOR), turns, omitted: 0 };
    }
    let first_user = entries.iter().position(|e| matches!(e, TranscriptEntry::User { .. }));
    let head: Vec<String> = first_user.map(|i| blocks[i].clone()).into_iter().collect();
    let tail_from = first_user.map_or(0, |i| i + 1);
    let tail = &blocks[tail_from..];
    let mut total = size(&head) + size(tail);
    // Whatever came before the first user message goes too.
    let mut dropped = first_user.unwrap_or(0);
    let mut skip = 0;
    while tail.len() - skip > 1 && total > max_chars {
        total -= units(&tail[skip]) + SEPARATOR.len();
        skip += 1;
        dropped += 1;
    }
    let marker = format!("[… {dropped} earlier entries omitted to fit the summarizer's window …]");
    let parts: Vec<&str> = head
        .iter()
        .map(String::as_str)
        .chain([marker.as_str()])
        .chain(tail[skip..].iter().map(String::as_str))
        .collect();
    Rendered { text: parts.join(SEPARATOR), turns, omitted: dropped }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries() -> Vec<TranscriptEntry> {
        vec![
            TranscriptEntry::User { text: "task".into() },
            TranscriptEntry::Assistant { text: "on it".into() },
            TranscriptEntry::ToolCall { name: "Bash".into(), input: "x".repeat(50) },
            TranscriptEntry::ToolResult { text: "boom".into(), is_error: true },
            TranscriptEntry::User { text: "next".into() },
        ]
    }

    // core/src/__tests__/compaction.test.ts
    #[test]
    fn renders_labelled_blocks_clips_tool_io_and_counts_user_turns() {
        let r = render_with(&entries(), 10_000, 10);
        assert_eq!((r.turns, r.omitted), (2, 0));
        assert!(r.text.starts_with("[user]\ntask\n\n[assistant]\non it"), "{}", r.text);
        assert!(r.text.contains("[tool call: Bash]\nxxxxxxxxxx… [40 more chars]"), "{}", r.text);
        assert!(r.text.contains("[tool result (error)]\nboom"), "{}", r.text);
    }

    #[test]
    fn drops_the_oldest_entries_to_fit_always_keeping_the_first_user_message() {
        let r = render_with(&entries(), 60, 10);
        assert!(r.omitted > 0);
        assert!(r.text.starts_with("[user]\ntask"), "the task statement survives");
        assert!(r.text.contains("earlier entries omitted"));
        assert!(r.text.ends_with("[user]\nnext"), "the most recent work survives");
    }

    #[test]
    fn is_due_only_when_enabled_and_at_or_over_the_threshold_of_a_known_window() {
        assert!(is_compaction_due(true, 0.7, 140_000, Some(200_000)));
        assert!(!is_compaction_due(true, 0.7, 138_000, Some(200_000)));
        assert!(!is_compaction_due(false, 0.7, 190_000, Some(200_000)));
        assert!(!is_compaction_due(true, 0.7, 190_000, None));
        assert!(!is_compaction_due(true, 0.7, 0, Some(200_000)));
    }

    #[test]
    fn waits_for_subagents_below_the_cap_only() {
        assert!(should_defer_compaction(2, 150_000, Some(200_000), 0.95));
        assert!(!should_defer_compaction(0, 150_000, Some(200_000), 0.95));
        assert!(should_defer_compaction(1, 188_000, Some(200_000), 0.95));
        assert!(!should_defer_compaction(1, 190_000, Some(200_000), 0.95));
    }

    #[test]
    fn keeps_only_the_summary_block_falling_back_to_the_answer_minus_its_analysis() {
        assert_eq!(extract_summary("<analysis>think</analysis>\n<summary>\n1. Task\n</summary>"), "1. Task");
        assert_eq!(extract_summary("<analysis>think</analysis>\nplain summary"), "plain summary");
        assert_eq!(extract_summary("<summary>a</summary> <summary>b</summary>"), "b");
        assert_eq!(extract_summary("<analysis>only thinking</analysis>"), "");
    }

    #[test]
    fn budgets_the_transcript_from_the_summarizers_window() {
        assert_eq!(transcript_char_budget(Some(200_000)), 420_000);
        assert_eq!(transcript_char_budget(None), transcript_char_budget(Some(200_000)));
        assert_eq!(estimate_tokens("1234567"), 2);
    }
}
