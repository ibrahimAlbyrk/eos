//! A routine's playbook (04 G12c): lines the night adds from the routine's
//! notes, kept only when a replay on past items comes closer to what the
//! user sent than the old playbook did.

use crate::text::estimate_tokens;

use super::budget::RUN_PLAYBOOK_TOKENS;
use super::note::PlaybookLine;

/// How much closer a rewritten playbook's replays must come, at least.
pub const KEEP_MARGIN: f64 = 0.02;

/// The playbook as one note text, a line each.
pub fn text_of(lines: &[PlaybookLine]) -> String {
    lines.iter().map(|line| line.text.trim()).collect::<Vec<_>>().join("\n")
}

/// `current` with as many of `added` as fit the run pack's playbook budget,
/// in order; a line already in it is not added twice.
pub fn with_additions(current: &[PlaybookLine], added: Vec<PlaybookLine>) -> Vec<PlaybookLine> {
    let mut lines = current.to_vec();
    for line in added {
        let text = line.text.trim();
        if text.is_empty() || lines.iter().any(|l| l.text.trim().eq_ignore_ascii_case(text)) {
            continue;
        }
        let mut next = lines.clone();
        next.push(PlaybookLine { text: text.to_owned(), from: line.from });
        if estimate_tokens(&text_of(&next)) > RUN_PLAYBOOK_TOKENS {
            break;
        }
        lines = next;
    }
    lines
}

fn words(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_lowercase).collect()
}

/// Normalized edit similarity of two texts by words: 1 minus the word edit
/// distance over the longer text's length. Two empty texts are the same.
pub fn edit_similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (words(a), words(b));
    let longest = a.len().max(b.len());
    if longest == 0 {
        return 1.0;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, word) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, other) in b.iter().enumerate() {
            let replaced = diagonal + usize::from(word != other);
            diagonal = row[j + 1];
            row[j + 1] = replaced.min(row[j] + 1).min(row[j + 1] + 1);
        }
    }
    1.0 - row[b.len()] as f64 / longest as f64
}

/// Whether a rewrite that scored `new` against the old playbook's `old` is
/// kept.
pub fn beats(old: f64, new: f64) -> bool {
    new - old >= KEEP_MARGIN - 1e-9
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> PlaybookLine {
        PlaybookLine { text: text.into(), from: vec![] }
    }

    #[test]
    fn edit_similarity_counts_words_changed() {
        assert_eq!(edit_similarity("", ""), 1.0);
        assert_eq!(edit_similarity("a b c d", "a b c d"), 1.0);
        assert_eq!(edit_similarity("a b c d", "a x c d"), 0.75);
        assert_eq!(edit_similarity("a b", "a b c d"), 0.5);
        assert_eq!(edit_similarity("A b", "a B"), 1.0);
        assert_eq!(edit_similarity("a", ""), 0.0);
    }

    #[test]
    fn a_rewrite_must_win_by_the_margin() {
        assert!(beats(0.50, 0.52));
        assert!(!beats(0.50, 0.519));
        assert!(!beats(0.6, 0.5));
    }

    #[test]
    fn additions_keep_the_old_lines_skip_repeats_and_stop_at_the_budget() {
        let current = vec![line("Keep summaries short.")];
        let added = vec![line("keep summaries short."), line("Name the failing test."), line(&"word ".repeat(3000))];
        let lines = with_additions(&current, added);
        assert_eq!(text_of(&lines), "Keep summaries short.\nName the failing test.");
    }
}
