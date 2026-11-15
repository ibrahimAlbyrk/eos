//! Context compaction: when a session summarizes its conversation, what of
//! the model's answer the conversation goes on from, and how big that is.

use crate::text::js_trim;

/// Rough characters per token for mixed prose and code; estimates only.
const CHARS_PER_TOKEN: f64 = 3.5;

/// What the message a conversation goes on from holds its summary in
/// (`compaction/continuation`): it tells that message from the user's prompts.
pub const SUMMARY_OPEN: &str = "<compaction_summary>";

/// The context size at which a session on a `window`-token model summarizes
/// by itself: `threshold` of the window, when automatic compaction is on.
pub fn compact_at(enabled: bool, threshold: f64, window: i64) -> Option<u64> {
    (enabled && threshold > 0.0 && window > 0).then(|| (window as f64 * threshold.min(1.0)).floor() as u64)
}

/// Tokens `text` takes, roughly (UTF-16 units, as the TypeScript estimate).
pub fn estimate_tokens(text: &str) -> i64 {
    (text.encode_utf16().count() as f64 / CHARS_PER_TOKEN).ceil() as i64
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

/// The summary the conversation goes on from. The model is asked for an
/// `<analysis>` scratchpad and a `<summary>` block; only the last summary is
/// kept. Without a summary block: the whole answer minus any analysis.
pub fn extract_summary(raw: &str) -> String {
    if let Some((_, _, inner)) = elements(raw, "summary").last() {
        return js_trim(inner).to_owned();
    }
    let mut rest = String::with_capacity(raw.len());
    let mut from = 0;
    for (start, end, _) in elements(raw, "analysis") {
        rest.push_str(&raw[from..start]);
        from = end;
    }
    rest.push_str(&raw[from..]);
    js_trim(&rest).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_at_the_threshold_of_the_window_only_when_on() {
        assert_eq!(compact_at(true, 0.7, 1_000_000), Some(700_000));
        assert_eq!(compact_at(false, 0.7, 1_000_000), None);
        assert_eq!(compact_at(true, 0.7, 0), None);
        assert_eq!(compact_at(true, 1.5, 200_000), Some(200_000));
    }

    #[test]
    fn keeps_only_the_summary_block_falling_back_to_the_answer_minus_its_analysis() {
        assert_eq!(extract_summary("<analysis>think</analysis>\n<summary>\n1. Task\n</summary>"), "1. Task");
        assert_eq!(extract_summary("<analysis>think</analysis>\nplain summary"), "plain summary");
        assert_eq!(extract_summary("<summary>a</summary> <summary>b</summary>"), "b");
        assert_eq!(extract_summary("<analysis>only thinking</analysis>"), "");
    }

    #[test]
    fn estimates_tokens_from_utf16_length() {
        assert_eq!(estimate_tokens("1234567"), 2);
        assert_eq!(estimate_tokens(""), 0);
    }
}
