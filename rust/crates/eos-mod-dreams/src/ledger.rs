//! The dream's candidate ledger (`core/src/domain/dream-ledger.ts`). A
//! candidate is something that may become a memory once it has shown up
//! enough. Support is counted by occasion (a chat on a day), never by
//! mentions: saying the same thing four times inside one task is one
//! occasion. A candidate is ready when the user stated it as a standing rule,
//! when it came back in separate chats on separate days, or when it guards a
//! public or irreversible action. Candidates nothing reinforces fade.

use std::collections::{BTreeSet, HashSet};

use eos_contracts::{
    DreamCandidate, DreamCandidateObject, DreamEvidence, DreamMatchGroup, DreamSignal, DreamSignalObject, DreamSupport,
    DreamSupportSummary, DreamSupportSummaryOrigin, UserMemory, UserMemoryScope, UserMemoryScopeProject,
    UserMemoryStatus,
};
use eos_domain::text::{collapse_spaces, js_trim};
use eos_domain::time::iso_from_ms;
use eos_domain::user_memory::scope_covers;
use unicode_normalization::UnicodeNormalization;

pub const CANDIDATE_TTL_MS: i64 = 30 * 24 * 60 * 60_000;
pub const LEDGER_MAX: usize = 200;
const SUPPORT_MAX: usize = 24;
const SUPPORT_EVIDENCE_MAX: usize = 4;

/// A recall signal with where and when it was said.
#[derive(Debug, Clone, PartialEq)]
pub struct NightSignal {
    pub signal: DreamSignal,
    pub worker_id: String,
    pub chat: String,
    pub project: Option<String>,
    /// When the user said it (the earliest cited line).
    pub at: i64,
    /// The user's cited lines.
    pub evidence: Vec<DreamEvidence>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchResult {
    pub ledger: Vec<DreamCandidate>,
    pub known: i64,
    pub declined: i64,
    pub invalid: i64,
}

// ---- markers --------------------------------------------------------------------

/// Lower case, Turkish letters folded to ASCII (the user often types without
/// them), accents dropped.
pub fn fold_text(text: &str) -> String {
    let turkish: String = text.chars().map(|c| if c == 'I' || c == 'İ' { 'i' } else { c }).collect();
    let lower = turkish.to_lowercase().replace('ı', "i");
    lower.nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect()
}

fn folded_line(text: &str) -> String {
    js_trim(&collapse_spaces(&fold_text(text))).to_owned()
}

/// The model's marker counts only if the user's own lines contain it.
pub fn grounded_marker(marker: Option<&str>, user_lines: &[&str]) -> Option<String> {
    let marker = marker.map(js_trim).filter(|m| !m.is_empty())?;
    let folded = folded_line(marker);
    user_lines.iter().any(|line| folded_line(line).contains(&folded)).then(|| marker.to_owned())
}

/// "every project", "everywhere", and how the user says it in Turkish.
fn says_everywhere(folded: &str) -> bool {
    let words: Vec<&str> =
        folded.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).collect();
    let noun = |w: &str, plural: bool| {
        ["project", "repo"].iter().any(|n| w == *n || (plural && w.strip_suffix('s') == Some(n)))
    };
    words.contains(&"everywhere")
        || words.windows(2).any(|pair| {
            (matches!(pair[0], "every" | "all" | "any") && noun(pair[1], true))
                || (pair[0] == "her" && ["proje", "repo", "yerde"].iter().any(|n| pair[1].starts_with(n)))
                || (matches!(pair[0], "tum" | "butun") && ["proje", "repo"].iter().any(|n| pair[1].starts_with(n)))
        })
}

// ---- support ----------------------------------------------------------------------

/// The date of `at` on the user's clock, `offset_minutes` east of UTC.
pub fn day_key(at: i64, offset_minutes: i32) -> String {
    iso_from_ms(at + i64::from(offset_minutes) * 60_000).chars().take(10).collect()
}

fn support_of(night: &NightSignal, offset_minutes: i32) -> DreamSupport {
    DreamSupport {
        worker_id: night.worker_id.clone(),
        chat: night.chat.clone(),
        project: night.project.clone(),
        day: day_key(night.at, offset_minutes),
        at: night.at.into(),
        stance: night.signal.stance,
        marker: night.signal.marker.clone(),
        reason: night.signal.reason.clone(),
        irreversible: night.signal.irreversible,
        evidence: night.evidence.iter().take(SUPPORT_EVIDENCE_MAX).cloned().collect(),
    }
}

fn at(support: &DreamSupport) -> i64 {
    support.at.0 as i64
}

/// Rereading a chat (a failed night tried again) never counts the same lines twice.
fn same_occasion_lines(a: &DreamSupport, b: &DreamSupport) -> bool {
    a.worker_id == b.worker_id && b.evidence.iter().any(|e| a.evidence.iter().any(|x| x.event_id == e.event_id))
}

fn with_support(mut candidate: DreamCandidate, add: Vec<DreamSupport>) -> DreamCandidate {
    let fresh: Vec<DreamSupport> =
        add.into_iter().filter(|s| !candidate.support.iter().any(|x| same_occasion_lines(x, s))).collect();
    if fresh.is_empty() {
        return candidate;
    }
    let first = fresh.iter().map(at).min().unwrap_or(i64::MAX).min(candidate.first_seen.0 as i64);
    let last = fresh.iter().map(at).max().unwrap_or(i64::MIN).max(candidate.last_seen.0 as i64);
    candidate.support.extend(fresh);
    candidate.support.sort_by_key(at);
    let over = candidate.support.len().saturating_sub(SUPPORT_MAX);
    candidate.support.drain(..over);
    candidate.first_seen = first.into();
    candidate.last_seen = last.into();
    candidate
}

/// How much stands behind a candidate, and whether it guards an irreversible action.
pub fn summarize_support(candidate: &DreamCandidate) -> (DreamSupportSummary, bool) {
    let support = &candidate.support;
    let count = |keys: BTreeSet<&str>| keys.len() as i64;
    let explicit = support.iter().any(|s| s.marker.is_some());
    let summary = DreamSupportSummary {
        chats: count(support.iter().map(|s| s.worker_id.as_str()).collect()),
        days: count(support.iter().map(|s| s.day.as_str()).collect()),
        projects: count(support.iter().filter_map(|s| s.project.as_deref()).collect()),
        first_seen: candidate.first_seen,
        last_seen: candidate.last_seen,
        origin: if explicit { DreamSupportSummaryOrigin::Explicit } else { DreamSupportSummaryOrigin::Inferred },
    };
    (summary, support.iter().any(|s| s.irreversible))
}

pub fn is_candidate_ready(candidate: &DreamCandidate) -> bool {
    let (summary, irreversible) = summarize_support(candidate);
    summary.origin == DreamSupportSummaryOrigin::Explicit || irreversible || (summary.chats >= 2 && summary.days >= 2)
}

/// Global once seen in two settings (two projects, or a project and a chat
/// with no folder), or when the user said it holds everywhere; otherwise the
/// one project.
pub fn candidate_scope(candidate: &DreamCandidate) -> UserMemoryScope {
    let settings: BTreeSet<&str> = candidate.support.iter().map(|s| s.project.as_deref().unwrap_or("")).collect();
    let everywhere =
        candidate.support.iter().any(|s| s.marker.as_deref().is_some_and(|m| says_everywhere(&fold_text(m))));
    let only = candidate.support.first().and_then(|s| s.project.clone()).filter(|p| !p.is_empty());
    match only {
        Some(path) if settings.len() < 2 && !everywhere => UserMemoryScope::Project(UserMemoryScopeProject { path }),
        _ => UserMemoryScope::Global,
    }
}

/// Drops what nothing reinforced lately; keeps the ledger bounded.
pub fn decay_ledger(ledger: Vec<DreamCandidate>, now: i64) -> Vec<DreamCandidate> {
    let mut kept: Vec<DreamCandidate> =
        ledger.into_iter().filter(|c| now - (c.last_seen.0 as i64) < CANDIDATE_TTL_MS).collect();
    kept.sort_by_key(|c| std::cmp::Reverse(c.last_seen.0 as i64));
    kept.truncate(LEDGER_MAX);
    kept
}

// ---- matching -----------------------------------------------------------------------

/// Files tonight's signals per the model's groups: support for an open
/// candidate, a new candidate, or a memory that already says it (known /
/// declined). A group that contradicts a kept memory, or shows a kept project
/// memory in another setting, becomes a candidate aimed at that memory. Each
/// signal counts once; a group that resolves to nothing is invalid.
pub fn apply_matches(
    ledger: Vec<DreamCandidate>,
    night: &[NightSignal],
    groups: &[DreamMatchGroup],
    memories: &[UserMemory],
    offset_minutes: i32,
    mut new_id: impl FnMut() -> String,
) -> MatchResult {
    let mut next = ledger;
    let mut used: HashSet<usize> = HashSet::new();
    let (mut known, mut declined, mut invalid) = (0, 0, 0);
    let supports = |signals: &[&NightSignal]| signals.iter().map(|s| support_of(s, offset_minutes)).collect::<Vec<_>>();
    let reinforce = |next: &mut Vec<DreamCandidate>, at: usize, add: Vec<DreamSupport>| {
        let candidate = next.remove(at);
        next.insert(at, with_support(candidate, add));
    };

    for group in groups {
        let indexes: Vec<usize> = group.signals.iter().filter_map(|i| usize::try_from(*i).ok()).collect();
        let signals: Vec<&NightSignal> =
            indexes.iter().filter(|i| **i < night.len() && !used.contains(i)).map(|i| &night[*i]).collect();
        if signals.is_empty() {
            invalid += 1;
            continue;
        }
        used.extend(indexes);
        let memory = group.memory.as_deref().and_then(|id| memories.iter().find(|m| m.id.0 == id));
        if memory.is_some_and(|m| m.status == UserMemoryStatus::Dismissed) {
            declined += 1;
            continue;
        }
        let active = memory.filter(|m| m.status == UserMemoryStatus::Active);
        // A kept project memory showing up in another setting may hold everywhere.
        let elsewhere = active.is_some_and(|m| signals.iter().any(|s| !scope_covers(&m.scope, s.project.as_deref())));
        if memory.is_some() && !(active.is_some() && (group.contradicts || elsewhere)) {
            known += 1;
            continue;
        }
        let open = group.candidate.as_deref().and_then(|id| next.iter().position(|c| c.id == id));
        if let (Some(open), None) = (open, memory) {
            reinforce(&mut next, open, supports(&signals));
            continue;
        }
        let target = memory.map(|m| m.id.0.clone());
        if let Some(aimed) = target.as_deref().and_then(|t| next.iter().position(|c| c.target.as_deref() == Some(t))) {
            reinforce(&mut next, aimed, supports(&signals));
            continue;
        }
        let claim = group.claim.clone().or_else(|| memory.filter(|_| !group.contradicts).map(|m| m.text.clone()));
        let Some(claim) = claim.map(|c| js_trim(&c).to_owned()).filter(|c| !c.is_empty()) else {
            invalid += 1;
            continue;
        };
        let mut support = supports(&signals);
        support.sort_by_key(at);
        let first = support.remove(0);
        let user_fact = signals.iter().all(|s| s.signal.object == DreamSignalObject::UserFact);
        let candidate = DreamCandidate {
            id: new_id(),
            claim,
            object: if user_fact { DreamCandidateObject::UserFact } else { DreamCandidateObject::AgentBehaviour },
            target,
            first_seen: first.at,
            last_seen: first.at,
            support: vec![first],
        };
        next.push(with_support(candidate, support));
    }
    MatchResult { ledger: next, known, declined, invalid }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DAY: i64 = 24 * 60 * 60_000;
    /// 2026-03-10 12:00 UTC.
    const NOON: i64 = 1_773_144_000_000;

    fn night(worker: &str, project: Option<&str>, at: i64, event: i64, marker: Option<&str>) -> NightSignal {
        let signal = json!({"ask": "run tests first", "object": "agent-behaviour", "stance": "general-rule",
                            "marker": marker, "evidence": [event]});
        NightSignal {
            signal: serde_json::from_value(signal).expect("a signal"),
            worker_id: worker.into(),
            chat: worker.into(),
            project: project.map(str::to_owned),
            at,
            evidence: vec![DreamEvidence {
                quote: "q".into(),
                worker_id: worker.into(),
                chat: worker.into(),
                event_id: Some(event),
                by: eos_contracts::DreamEvidenceBy::User,
            }],
        }
    }

    fn group(value: serde_json::Value) -> DreamMatchGroup {
        serde_json::from_value(value).expect("a group")
    }

    fn memory(id: &str, scope: serde_json::Value, status: &str) -> UserMemory {
        serde_json::from_value(json!({
            "id": id, "text": "When done, run the tests.", "category": "work-style", "scope": scope, "tier": "always",
            "status": status, "source": {"kind": "user"}, "rev": 1, "createdAt": 1, "updatedAt": 1,
        }))
        .expect("a memory")
    }

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("dc-{n}")
        }
    }

    // core/src/__tests__/dream-ledger.test.ts
    #[test]
    fn a_marker_counts_only_when_the_users_own_lines_contain_it_turkish_letters_or_not() {
        assert_eq!(grounded_marker(Some(" Her Zaman "), &["bunu  her zaman yap"]).as_deref(), Some("Her Zaman"));
        assert_eq!(
            grounded_marker(Some("bütün projelerde"), &["BUTUN PROJELERDE boyle"]).as_deref(),
            Some("bütün projelerde")
        );
        assert_eq!(grounded_marker(Some("always"), &["do it now"]), None);
        assert_eq!(grounded_marker(Some("  "), &["anything"]), None);
        assert_eq!(fold_text("IŞIK Çağrı"), "isik cagri");
    }

    #[test]
    fn one_group_is_one_candidate_and_support_counts_occasions_not_mentions() {
        let tonight = [night("w1", Some("/p"), NOON, 1, None), night("w1", Some("/p"), NOON + 60_000, 2, None)];
        let first = apply_matches(
            Vec::new(),
            &tonight,
            &[group(json!({"signals": [0, 1], "claim": " Run tests "}))],
            &[],
            0,
            ids(),
        );
        assert_eq!((first.ledger.len(), first.known, first.declined, first.invalid), (1, 0, 0, 0));
        let candidate = &first.ledger[0];
        assert_eq!(
            (candidate.id.as_str(), candidate.claim.as_str(), candidate.support.len()),
            ("dc-1", "Run tests", 2)
        );
        let (summary, _) = summarize_support(candidate);
        assert_eq!((summary.chats, summary.days, summary.projects), (1, 1, 1));
        assert!(!is_candidate_ready(candidate), "one chat on one day, never stated as a rule");

        // Another chat on another day backs it; rereading the same lines never counts twice.
        let later = [night("w2", Some("/p"), NOON + DAY, 9, None), night("w1", Some("/p"), NOON, 1, None)];
        let groups = [group(json!({"signals": [0, 1], "candidate": "dc-1"}))];
        let second = apply_matches(first.ledger, &later, &groups, &[], 0, ids());
        assert_eq!(second.ledger[0].support.len(), 3);
        assert!(is_candidate_ready(&second.ledger[0]));
        assert_eq!(second.ledger[0].last_seen.0 as i64, NOON + DAY);
        assert_eq!(day_key(NOON + DAY, 0), "2026-03-11");
        assert_eq!(day_key(NOON + DAY, 13 * 60), "2026-03-12", "the user's own date");
    }

    #[test]
    fn a_memory_that_already_says_it_is_known_or_declined_and_one_it_contradicts_is_aimed_at() {
        let project = json!({"kind": "project", "path": "/p"});
        let memories = [
            memory("um-000000000001", project, "active"),
            memory("um-000000000002", json!({"kind": "global"}), "dismissed"),
            memory("um-000000000003", json!({"kind": "global"}), "suggested"),
        ];
        let tonight = [
            night("w1", Some("/p"), NOON, 1, None),
            night("w1", Some("/p"), NOON, 2, None),
            night("w1", Some("/p"), NOON, 3, None),
            night("w1", Some("/p"), NOON, 4, None),
            night("w2", Some("/other"), NOON, 5, None),
        ];
        let groups = [
            group(json!({"signals": [0], "memory": "um-000000000001"})),
            group(json!({"signals": [1], "memory": "um-000000000002"})),
            group(json!({"signals": [2], "memory": "um-000000000003"})),
            group(json!({"signals": [3], "memory": "um-000000000001", "contradicts": true, "claim": "Skip the tests"})),
            group(json!({"signals": [4], "memory": "um-000000000001"})),
            group(json!({"signals": [4, 99]})),
            group(json!({"signals": [9]})),
        ];
        let matched = apply_matches(Vec::new(), &tonight, &groups, &memories, 0, ids());
        assert_eq!((matched.known, matched.declined, matched.invalid), (2, 1, 2));
        assert_eq!(matched.ledger.len(), 1, "the contradiction and the other setting aim at the same memory");
        let aimed = &matched.ledger[0];
        assert_eq!(
            (aimed.target.as_deref(), aimed.claim.as_str(), aimed.support.len()),
            (Some("um-000000000001"), "Skip the tests", 2)
        );
    }

    #[test]
    fn readiness_scope_and_fading() {
        let stated = apply_matches(
            Vec::new(),
            &[night("w1", Some("/p"), NOON, 1, Some("always"))],
            &[group(json!({"signals": [0], "claim": "c"}))],
            &[],
            0,
            ids(),
        );
        assert!(is_candidate_ready(&stated.ledger[0]), "stated as a standing rule");
        assert!(matches!(candidate_scope(&stated.ledger[0]), UserMemoryScope::Project(p) if p.path == "/p"));

        let everywhere = apply_matches(
            Vec::new(),
            &[night("w1", Some("/p"), NOON, 1, Some("her projede"))],
            &[group(json!({"signals": [0], "claim": "c"}))],
            &[],
            0,
            ids(),
        );
        assert_eq!(candidate_scope(&everywhere.ledger[0]), UserMemoryScope::Global);
        let two = [night("w1", Some("/p"), NOON, 1, None), night("w2", None, NOON + DAY, 2, None)];
        let settings =
            apply_matches(Vec::new(), &two, &[group(json!({"signals": [0, 1], "claim": "c"}))], &[], 0, ids());
        assert_eq!(
            candidate_scope(&settings.ledger[0]),
            UserMemoryScope::Global,
            "a project and a chat with no folder"
        );

        let mut irreversible = night("w1", Some("/p"), NOON, 1, None);
        irreversible.signal.irreversible = true;
        let guarded =
            apply_matches(Vec::new(), &[irreversible], &[group(json!({"signals": [0], "claim": "c"}))], &[], 0, ids());
        assert!(is_candidate_ready(&guarded.ledger[0]));

        let ledger = vec![stated.ledger[0].clone(), settings.ledger[0].clone()];
        let kept = decay_ledger(ledger.clone(), NOON + CANDIDATE_TTL_MS + 1);
        assert_eq!(kept.len(), 1, "what nothing reinforced for a month fades");
        assert_eq!(decay_ledger(ledger, NOON + DAY).len(), 2);
    }
}
