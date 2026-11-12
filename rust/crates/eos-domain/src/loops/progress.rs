//! The only net on an unbounded loop: whether the worker's attempts still
//! make progress (`core/src/domain/loop-progress.ts`).

use eos_contracts::ChangedFile;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::LoopAttempt;

/// Attempts a loop remembers.
pub const RING_CAP: usize = 20;

/// Cycling between at most this many change-sets (while not converging)
/// reads as oscillation; one is frozen.
const OSCILLATION_DISTINCT_MAX: usize = 2;

/// Why a loop makes no progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoProgress {
    /// The same change-set across the whole window.
    Frozen,
    /// Cycling between a few change-sets.
    Oscillation,
    /// A new change-set every attempt, and the same unmet criteria each time.
    Stalled,
}

/// A key equal for equal sets of unmet criteria, whatever their order.
pub fn outcome_key(unmet: &[String]) -> String {
    let mut sorted: Vec<&str> = unmet.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.join("|")
}

/// The ring with `attempt` added, keeping the last [`RING_CAP`].
pub fn with_attempt(ring: &[LoopAttempt], attempt: LoopAttempt) -> Vec<LoopAttempt> {
    let skip = (ring.len() + 1).saturating_sub(RING_CAP);
    ring.iter().skip(skip).cloned().chain(std::iter::once(attempt)).collect()
}

/// A fingerprint of a worker's change-set: its whole diff (`None` when the
/// diff was too large or unreadable) and the list of changed files, as
/// today's `worktreeStateHash` hashes them.
pub fn state_hash(diff: Option<&str>, changed: &[ChangedFile]) -> String {
    let mut rows: Vec<(String, Value)> = changed
        .iter()
        .map(|f| {
            let status = serde_json::to_value(f.status).unwrap_or(Value::Null);
            let key = format!("{},{},{}", f.path, status.as_str().unwrap_or_default(), f.untracked);
            (key, json!([f.path, status, f.untracked]))
        })
        .collect();
    // JavaScript sorts arrays by their text: `path,status,untracked`.
    rows.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let files = Value::Array(rows.into_iter().map(|(_, row)| row).collect()).to_string();
    hex::encode(Sha256::digest(format!("{} {files}", diff.unwrap_or_default()).as_bytes()))
}

/// Why the last `window` attempts make no progress; `None` while there is
/// not a full window yet, or the unmet count fell across it (the worker is
/// closing criteria).
pub fn detect_no_progress(ring: &[LoopAttempt], window: usize) -> Option<NoProgress> {
    if window < 1 || ring.len() < window {
        return None;
    }
    let last = &ring[ring.len() - window..];
    if last[last.len() - 1].unmet_count < last[0].unmet_count {
        return None;
    }
    let mut states: Vec<&str> = last.iter().map(|a| a.state_hash.as_str()).collect();
    states.sort_unstable();
    states.dedup();
    match states.len() {
        1 => Some(NoProgress::Frozen),
        n if n <= OSCILLATION_DISTINCT_MAX => Some(NoProgress::Oscillation),
        _ if last.iter().all(|a| a.outcome_hash == last[0].outcome_hash) => Some(NoProgress::Stalled),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(state: &str, unmet: i64) -> LoopAttempt {
        at(state, unmet, "k")
    }

    fn at(state: &str, unmet: i64, outcome: &str) -> LoopAttempt {
        LoopAttempt {
            state_hash: state.into(),
            outcome_hash: outcome.into(),
            unmet_count: unmet,
            reason: String::new(),
        }
    }

    // core/src/__tests__/loop-progress.test.ts
    #[test]
    fn the_outcome_key_ignores_order() {
        let key = |ids: &[&str]| outcome_key(&ids.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        assert_eq!(key(&["b", "a", "c"]), key(&["c", "b", "a"]));
        assert_eq!(key(&["a", "b"]), "a|b");
    }

    #[test]
    fn no_progress_is_frozen_oscillating_or_stalled_over_a_full_window() {
        use NoProgress::*;
        assert_eq!(detect_no_progress(&[e("h", 1), e("h", 1)], 3), None, "not a full window");
        assert_eq!(detect_no_progress(&[e("h", 1), e("h", 1), e("h", 1)], 3), Some(Frozen));
        assert_eq!(detect_no_progress(&[e("a", 1), e("b", 1), e("a", 1)], 3), Some(Oscillation));
        assert_eq!(detect_no_progress(&[e("h", 3), e("h", 2), e("h", 1)], 3), None, "converging");
        assert_eq!(detect_no_progress(&[e("a", 2), e("b", 2), e("a", 1)], 3), None);
        assert_eq!(detect_no_progress(&[at("a", 1, "x"), at("b", 1, "y"), at("c", 1, "x")], 3), None, "exploring");
        assert_eq!(detect_no_progress(&[e("x", 9), e("h", 1), e("h", 1), e("h", 1)], 3), Some(Frozen), "last window");
        assert_eq!(detect_no_progress(&[e("a", 1), e("b", 1), e("c", 1)], 3), Some(Stalled));
        assert_eq!(detect_no_progress(&[e("a", 2), e("b", 2), e("c", 1)], 3), None);
    }

    #[test]
    fn the_state_hash_is_the_typescript_one() {
        // `worktreeStateHash` over the same input, in node: sha256 of `diff [["a.txt","M",false]]`.
        let changed: ChangedFile = serde_json::from_value(serde_json::json!(
            {"path": "a.txt", "status": "M", "insertions": 1, "deletions": 0, "untracked": false}
        ))
        .expect("a file");
        let expected = hex::encode(Sha256::digest(br#"diff [["a.txt","M",false]]"#));
        assert_eq!(state_hash(Some("diff"), &[changed]), expected);
        assert_eq!(state_hash(None, &[]), hex::encode(Sha256::digest(b" []")));
    }

    #[test]
    fn the_ring_keeps_the_last_twenty() {
        let ring: Vec<LoopAttempt> = (0..RING_CAP).map(|i| e(&i.to_string(), 1)).collect();
        let next = with_attempt(&ring, e("new", 1));
        assert_eq!(
            (next.len(), next[0].state_hash.as_str(), next[RING_CAP - 1].state_hash.as_str()),
            (RING_CAP, "1", "new")
        );
    }
}
