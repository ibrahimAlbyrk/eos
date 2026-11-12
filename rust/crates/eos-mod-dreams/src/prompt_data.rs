//! How a dream's data reads inside its prompts
//! (`core/src/domain/dream-prompt-data.ts`). Every block is one item per line
//! group, led by the id the model answers with (`s<N>`, `dc-…`, `um-…`,
//! `p<N>`), with the user's own words quoted under it.

use eos_contracts::{
    DreamCandidate, DreamEvidence, DreamSupportSummaryOrigin, UserMemory, UserMemoryScope, UserMemoryStatus,
};

use crate::ledger::{NightSignal, summarize_support};
use crate::rules::CheckedProposal;

const MEMORY_LIST_MAX: usize = 200;

fn quote(evidence: &DreamEvidence) -> String {
    let id = evidence.event_id.map_or_else(|| "null".to_owned(), |id| id.to_string());
    format!("    [e{id}] user: “{}”", evidence.quote)
}

fn text_of<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn scope_of(scope: &UserMemoryScope) -> String {
    match scope {
        UserMemoryScope::Global => "global".to_owned(),
        UserMemoryScope::Project(project) => format!("project {}", project.path),
    }
}

fn plural(n: i64, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// `s<N> · object · stance · chat (project) [· marker] [· reason]`, the ask, its quotes.
pub fn format_signals(night: &[NightSignal]) -> String {
    let blocks: Vec<String> = night
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let mut head = vec![
                format!("s{i}"),
                text_of(&n.signal.object),
                text_of(&n.signal.stance),
                format!("chat {} ({})", n.chat, n.project.as_deref().unwrap_or("no folder")),
            ];
            head.extend(n.signal.marker.as_ref().filter(|m| !m.is_empty()).map(|m| format!("marker “{m}”")));
            head.extend(n.signal.reason.as_ref().filter(|r| !r.is_empty()).map(|r| format!("reason: {r}")));
            let mut lines = vec![head.join(" · "), format!("  {}", n.signal.ask)];
            lines.extend(n.evidence.iter().take(3).map(quote));
            lines.join("\n")
        })
        .collect();
    if blocks.is_empty() { "(none)".to_owned() } else { blocks.join("\n") }
}

/// `dc-… · seen in N chats on D days across P projects [· explicit] [· changes um-…]`,
/// the claim; with `quotes`, the user's lines behind it.
pub fn format_candidates(candidates: &[DreamCandidate], quotes: bool) -> String {
    let blocks: Vec<String> = candidates
        .iter()
        .map(|c| {
            let (s, irreversible) = summarize_support(c);
            let seen = format!(
                "seen in {} on {} across {}",
                plural(s.chats, "chat"),
                plural(s.days, "day"),
                plural(s.projects, "project")
            );
            let mut head = vec![c.id.clone(), seen];
            if s.origin == DreamSupportSummaryOrigin::Explicit {
                head.push("stated as a standing rule".to_owned());
            }
            if irreversible {
                head.push("guards an irreversible action".to_owned());
            }
            head.extend(c.target.as_ref().map(|t| format!("would change kept memory {t}")));
            let mut lines = vec![head.join(" · "), format!("  {}", c.claim)];
            if quotes {
                let mut reasons: Vec<&str> = Vec::new();
                for reason in c.support.iter().filter_map(|x| x.reason.as_deref()).filter(|r| !r.is_empty()) {
                    if !reasons.contains(&reason) {
                        reasons.push(reason);
                    }
                }
                lines.extend(reasons.iter().map(|r| format!("    reason given: {r}")));
                let evidence: Vec<&DreamEvidence> = c.support.iter().flat_map(|x| &x.evidence).collect();
                lines.extend(evidence.iter().skip(evidence.len().saturating_sub(6)).map(|e| quote(e)));
            }
            lines.join("\n")
        })
        .collect();
    if blocks.is_empty() { "(none)".to_owned() } else { blocks.join("\n") }
}

/// Kept memories first (they are what update / merge / promote / retire can
/// target), then pending, then declined — the model must not propose those again.
pub fn format_memories(memories: &[UserMemory]) -> String {
    let rank = |m: &UserMemory| match m.status {
        UserMemoryStatus::Active => (0, "kept"),
        UserMemoryStatus::Suggested => (1, "pending"),
        UserMemoryStatus::Dismissed => (2, "declined"),
    };
    let mut sorted: Vec<&UserMemory> = memories.iter().collect();
    sorted.sort_by_key(|m| rank(m).0);
    let blocks: Vec<String> = sorted
        .iter()
        .take(MEMORY_LIST_MAX)
        .map(|m| {
            format!("{} · {} · {} · {}\n  {}", m.id.0, rank(m).1, scope_of(&m.scope), text_of(&m.category), m.text)
        })
        .collect();
    if blocks.is_empty() { "(none yet)".to_owned() } else { blocks.join("\n") }
}

/// `p<N> · kind · scope [· targets]`, the text, why it matters, the lines it rests on.
pub fn format_proposals(proposals: &[CheckedProposal]) -> String {
    let blocks: Vec<String> = proposals
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let (s, _) = summarize_support(&p.candidate);
            let mut head = vec![format!("p{i}"), text_of(&p.draft.kind), scope_of(&p.scope)];
            if !p.targets.is_empty() {
                head.push(format!("changes {}", p.targets.join(", ")));
            }
            head.push(format!("seen in {} chats on {} days", s.chats, s.days));
            let explicit = s.origin == DreamSupportSummaryOrigin::Explicit;
            head.push(if explicit { "stated as a standing rule" } else { "inferred" }.to_owned());
            let mut lines =
                vec![head.join(" · "), format!("  text: {}", p.draft.text), format!("  why: {}", p.draft.why)];
            let evidence: Vec<&DreamEvidence> = p.candidate.support.iter().flat_map(|x| &x.evidence).collect();
            lines.extend(evidence.iter().skip(evidence.len().saturating_sub(6)).map(|e| quote(e)));
            lines.join("\n")
        })
        .collect();
    blocks.join("\n")
}
