//! User memory rules: which memories a session may see, when two memories say
//! the same thing (so a suggestion never piles up a duplicate), keyword search
//! for the on-demand tier, and the writing rules a memory's text follows.

use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::HashSet;

use eos_contracts::{DreamProposalKind, UserMemory, UserMemoryProposal, UserMemoryScope, UserMemoryStatus};

use crate::text::{collapse_spaces, js_re, js_trim, utf16_len};

/// Two texts at or above this similarity say the same thing.
pub const DUPLICATE_SIMILARITY: f64 = 0.8;

/// The longest a memory may be, in words.
pub const MEMORY_WORDS_MAX: usize = 40;

/// One line, single spaces, no outer whitespace.
pub fn normalize_memory_text(text: &str) -> String {
    js_trim(&collapse_spaces(text)).to_owned()
}

/// A project memory covers its folder and everything below it.
pub fn scope_covers(scope: &UserMemoryScope, project: Option<&str>) -> bool {
    let UserMemoryScope::Project(scope) = scope else { return true };
    let Some(project) = project.filter(|p| !p.is_empty()) else { return false };
    project == scope.path
        || project.strip_prefix(scope.path.trim_end_matches('/')).is_some_and(|below| below.starts_with('/'))
}

/// Kept memories a session in `project` may see.
pub fn memories_in_scope<'a, M: Borrow<UserMemory>>(memories: &'a [M], project: Option<&str>) -> Vec<&'a M> {
    let visible = |m: &UserMemory| m.status == UserMemoryStatus::Active && scope_covers(&m.scope, project);
    memories.iter().filter(|m| visible((*m).borrow())).collect()
}

/// The words of a text: lowercase runs of letters and digits, two UTF-16
/// units or longer.
fn words(text: &str) -> HashSet<String> {
    let lower = text.to_lowercase();
    let separators = js_re!(r"[^\p{L}\p{N}]+", "u");
    let mut out = HashSet::new();
    let mut at = 0;
    let mut keep = |word: &str| {
        if utf16_len(word) >= 2 {
            out.insert(word.to_owned());
        }
    };
    for m in separators.find_iter(&lower) {
        keep(&lower[at..m.start()]);
        at = m.end();
    }
    keep(&lower[at..]);
    out
}

/// How alike two texts are, 0 to 1: shared words over all words. Order and
/// punctuation do not matter.
pub fn memory_similarity(a: &str, b: &str) -> f64 {
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    let shared = wa.iter().filter(|w| wb.contains(*w)).count();
    shared as f64 / (wa.len() + wb.len() - shared) as f64
}

/// An existing memory (kept or pending) that already says `text` for this
/// scope: the most alike one. A global memory covers any project, so it also
/// counts against a project suggestion.
pub fn find_duplicate_memory<'a, M: Borrow<UserMemory>>(
    text: &str,
    scope: &UserMemoryScope,
    pool: &'a [M],
) -> Option<&'a M> {
    let mut best: Option<(&M, f64)> = None;
    for candidate in pool {
        let m: &UserMemory = candidate.borrow();
        if m.scope != UserMemoryScope::Global && m.scope != *scope {
            continue;
        }
        let score = memory_similarity(text, &m.text);
        if score >= DUPLICATE_SIMILARITY && score > best.map_or(0.0, |(_, s)| s) {
            best = Some((candidate, score));
        }
    }
    best.map(|(m, _)| m)
}

fn target_key(proposal: &UserMemoryProposal) -> Vec<&str> {
    let mut ids: Vec<&str> = proposal.targets.iter().map(|id| id.0.as_str()).collect();
    ids.sort_unstable();
    ids
}

/// A change proposal (update, merge, promote, retire) already pending or
/// declined for the same targets, or an update that would not change its
/// target's text.
pub fn find_duplicate_proposal<'a, M: Borrow<UserMemory>>(
    text: &str,
    proposal: &UserMemoryProposal,
    pool: &'a [M],
) -> Option<&'a M> {
    let key = target_key(proposal);
    let alike = |m: &UserMemory| memory_similarity(text, &m.text) >= DUPLICATE_SIMILARITY;
    let same = pool.iter().find(|m| {
        let m: &UserMemory = (*m).borrow();
        m.status != UserMemoryStatus::Active
            && m.proposal.as_ref().is_some_and(|p| p.kind == proposal.kind && target_key(p) == key)
            && (proposal.kind == DreamProposalKind::Retire || alike(m))
    });
    if same.is_some() {
        return same;
    }
    if proposal.kind == DreamProposalKind::Update {
        let first = proposal.targets.first()?;
        return pool.iter().find(|m| (*m).borrow().id == *first).filter(|m| alike((*m).borrow()));
    }
    None
}

/// Newest first, by `updatedAt`.
pub fn newest_first(a: &UserMemory, b: &UserMemory) -> Ordering {
    b.updated_at.0.partial_cmp(&a.updated_at.0).unwrap_or(Ordering::Equal)
}

/// Global memories before project ones, then newest first: the order the
/// prompt block fills its budget in.
pub fn global_first_then_newest(a: &UserMemory, b: &UserMemory) -> Ordering {
    let rank = |m: &UserMemory| u8::from(m.scope != UserMemoryScope::Global);
    rank(a).cmp(&rank(b)).then_with(|| newest_first(a, b))
}

/// The share of the query's words a text holds, whole or as a prefix of one
/// of its words.
fn match_score(query: &HashSet<String>, text: &str) -> f64 {
    let w = words(text);
    let hits = query.iter().filter(|q| w.contains(*q) || w.iter().any(|x| x.starts_with(q.as_str()))).count();
    hits as f64 / query.len() as f64
}

/// Kept memories in scope ranked by how many query words they contain; an
/// empty query lists the newest first.
pub fn search_memories<'a, M: Borrow<UserMemory>>(
    memories: &'a [M],
    query: &str,
    project: Option<&str>,
    limit: usize,
) -> Vec<&'a M> {
    let mut pool = memories_in_scope(memories, project);
    let q = words(query);
    if q.is_empty() {
        pool.sort_by(|a, b| newest_first((*a).borrow(), (*b).borrow()));
        pool.truncate(limit);
        return pool;
    }
    let mut ranked: Vec<(&M, f64)> =
        pool.into_iter().map(|m| (m, match_score(&q, &m.borrow().text))).filter(|(_, score)| *score > 0.0).collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then_with(|| newest_first(a.0.borrow(), b.0.borrow()))
    });
    ranked.into_iter().take(limit).map(|(m, _)| m).collect()
}

/// Why a memory's text breaks the format agents follow best — a rule that
/// opens with its situation, or a fact about the user — or `None` when it is
/// fine (`lintMemoryText`).
pub fn lint_memory_text(text: &str) -> Option<String> {
    let t = js_trim(text);
    let words = collapse_spaces(t).split(' ').count();
    if words > MEMORY_WORDS_MAX {
        return Some(format!("longer than {MEMORY_WORDS_MAX} words"));
    }
    if js_re!(r"^(When|Whenever|Before|After|If|While|The user)\b").find(t).is_none() {
        return Some("doesn't open with its situation (When…, Before…) or \"The user…\"".to_owned());
    }
    if let Some(hedge) = js_re!(r"\b(often|usually|tends? to|sometimes|generally|typically)\b", "i").find(t) {
        return Some(format!("hedges with \"{}\" instead of naming the situation", &t[hedge.range()]));
    }
    if js_re!(r"\b(MUST|NEVER|ALWAYS|IMPORTANT|CRITICAL)\b").find(t).is_some() {
        return Some("shouts in capitals".to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use eos_contracts::{
        Num, UserMemoryCategory, UserMemoryId, UserMemoryScopeProject, UserMemorySource, UserMemoryTier,
    };

    use super::*;

    fn project(path: &str) -> UserMemoryScope {
        UserMemoryScope::Project(UserMemoryScopeProject { path: path.to_owned() })
    }

    fn mem(seq: u32, text: &str) -> UserMemory {
        UserMemory {
            id: UserMemoryId(format!("um-mem{seq:05}")),
            text: text.to_owned(),
            category: UserMemoryCategory::WorkStyle,
            domain: None,
            scope: UserMemoryScope::Global,
            tier: UserMemoryTier::Always,
            status: UserMemoryStatus::Active,
            source: UserMemorySource::User,
            proposal: None,
            rev: 0,
            created_at: Num(f64::from(seq)),
            updated_at: Num(f64::from(seq)),
        }
    }

    fn ids(found: &[&UserMemory]) -> Vec<String> {
        found.iter().map(|m| m.id.0.clone()).collect()
    }

    #[test]
    fn project_scope_covers_the_folder_and_below_nothing_else() {
        let eos = project("/Users/me/eos");
        assert!(scope_covers(&eos, Some("/Users/me/eos")));
        assert!(scope_covers(&eos, Some("/Users/me/eos/app/ui")));
        assert!(!scope_covers(&eos, Some("/Users/me/eos-old")));
        assert!(!scope_covers(&eos, None));
        assert!(scope_covers(&UserMemoryScope::Global, None));
        assert!(scope_covers(&project("/Users/me/eos//"), Some("/Users/me/eos/app")));
    }

    #[test]
    fn only_kept_memories_are_in_scope() {
        let kept = mem(1, "a b");
        let mut pending = mem(2, "c d");
        pending.status = UserMemoryStatus::Suggested;
        assert_eq!(ids(&memories_in_scope(&[kept, pending], None)), ["um-mem00001"]);
    }

    #[test]
    fn similarity_ignores_case_order_and_punctuation() {
        assert_eq!(memory_similarity("Be concise, always.", "always be CONCISE"), 1.0);
        assert!(memory_similarity("Use tabs", "Use spaces") < 0.8);
        assert_eq!(memory_similarity("a", "a"), 0.0, "one-letter words do not count");
    }

    #[test]
    fn duplicates_match_within_the_same_scope_and_globals_cover_projects() {
        let eos = project("/Users/me/eos");
        let global = mem(1, "Write commits in English.");
        let mut other = mem(2, "Run lint before tests.");
        other.scope = project("/x");
        let pool = [global, other];
        assert_eq!(
            find_duplicate_memory("write commits in english", &eos, &pool).map(|m| m.id.0.as_str()),
            Some("um-mem00001")
        );
        assert!(find_duplicate_memory("Run lint before tests", &eos, &pool).is_none());
        let found = find_duplicate_memory("Run lint before tests", &project("/x"), &pool[1..]);
        assert_eq!(found.map(|m| m.id.0.as_str()), Some("um-mem00002"));
    }

    #[test]
    fn search_ranks_by_query_words_respects_scope_and_lists_newest_for_an_empty_query() {
        let a = mem(1, "Prefers pnpm over npm.");
        let b = mem(2, "Commit messages in English, terse.");
        let mut c = mem(3, "Never restart the daemon.");
        c.scope = project("/Users/me/eos");
        let mut d = mem(4, "Pending npm thing.");
        d.status = UserMemoryStatus::Suggested;
        let all = [a, b, c, d];
        assert_eq!(ids(&search_memories(&all, "npm commit", None, 5)), ["um-mem00002", "um-mem00001"]);
        assert!(search_memories(&all[..3], "restart daemon", None, 5).is_empty());
        assert_eq!(ids(&search_memories(&all[..3], "restart daemon", Some("/Users/me/eos"), 5)), ["um-mem00003"]);
        assert_eq!(ids(&search_memories(&all[..3], "", Some("/Users/me/eos"), 2)), ["um-mem00003", "um-mem00002"]);
    }

    #[test]
    fn the_writing_rules() {
        assert_eq!(lint_memory_text("When fixing a bug, find the root cause before changing code."), None);
        assert_eq!(lint_memory_text("Before posting on GitHub, show the draft and wait for approval."), None);
        assert_eq!(lint_memory_text("The user builds games in Unity."), None);
        assert!(lint_memory_text("Prefers minimal, airy UI.").is_some_and(|why| why.contains("situation")));
        assert!(
            lint_memory_text("When committing, usually split the changes.").is_some_and(|why| why.contains("usually"))
        );
        assert!(lint_memory_text("When committing, NEVER push.").is_some_and(|why| why.contains("capitals")));
        let long = format!("When x, {}", "word ".repeat(45));
        assert!(lint_memory_text(&long).is_some_and(|why| why.contains("40 words")));
    }
}
