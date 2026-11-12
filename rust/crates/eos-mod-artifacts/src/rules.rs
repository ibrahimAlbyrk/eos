//! The catalog's pure parts (`core/src/domain/artifact-catalog.ts`): merging
//! every sign-in's list into one, and telling that an agent just published an
//! artifact.

use std::collections::HashMap;

use eos_contracts::{AgentEvent, ArtifactSummary, ArtifactSummaryRel, ContentBlock};
use eos_domain::time::ms_from_iso;

/// An unparsable time sorts as the epoch, as `Date.parse` → `NaN` → 0 does.
fn time_of(iso: &str) -> i64 {
    ms_from_iso(iso).unwrap_or(0)
}

/// Newest first, one row per artifact. Two sign-ins see the same one when it
/// is shared from one to the other: the owner's row wins.
pub fn merge_artifacts<'a>(lists: impl IntoIterator<Item = &'a [ArtifactSummary]>) -> Vec<ArtifactSummary> {
    let mut order: Vec<&'a str> = Vec::new();
    let mut by_slug: HashMap<&'a str, &'a ArtifactSummary> = HashMap::new();
    for list in lists {
        for a in list {
            let better = match by_slug.get(a.slug.as_str()) {
                None => {
                    order.push(&a.slug);
                    true
                }
                Some(seen) => {
                    (seen.rel == ArtifactSummaryRel::Shared && a.rel == ArtifactSummaryRel::Mine)
                        || (seen.rel == a.rel && time_of(&a.updated_at) > time_of(&seen.updated_at))
                }
            };
            if better {
                by_slug.insert(&a.slug, a);
            }
        }
    }
    let mut merged: Vec<ArtifactSummary> =
        order.iter().filter_map(|slug| by_slug.get(slug)).map(|a| (*a).clone()).collect();
    // Stable, like `Array.prototype.sort`: equal times keep first-seen order.
    merged.sort_by_key(|a| std::cmp::Reverse(time_of(&a.updated_at)));
    merged
}

/// Claude Code's Artifact tool answers a publish with the artifact's link, in
/// either form: `https://(preview.)claude.(ai|com)/(code/)artifact/`.
fn holds_artifact_link(text: &str) -> bool {
    text.match_indices("https://").any(|(at, _)| {
        let rest = &text[at + "https://".len()..];
        let rest = rest.strip_prefix("preview.").unwrap_or(rest);
        let Some(rest) = rest.strip_prefix("claude.") else { return false };
        let Some(rest) = rest.strip_prefix("ai/").or_else(|| rest.strip_prefix("com/")) else { return false };
        let rest = rest.strip_prefix("code/").unwrap_or(rest);
        rest.starts_with("artifact/")
    })
}

pub fn announces_artifact(event: &AgentEvent) -> bool {
    let AgentEvent::Message(message) = event else { return false };
    message
        .blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult(result) if holds_artifact_link(&result.content)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(slug: &str, updated_at: &str, extra: serde_json::Value) -> ArtifactSummary {
        let mut base = json!({
            "slug": slug, "url": format!("https://claude.ai/artifact/{slug}"), "title": slug, "kind": "Page",
            "rel": "mine", "updatedAt": updated_at, "loginId": "a",
        });
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        serde_json::from_value(base).unwrap()
    }

    // core/src/__tests__/ArtifactCatalogService.test.ts, "mergeArtifacts"
    #[test]
    fn keeps_the_newer_of_two_rows_of_the_same_relation_and_sorts_unparsable_times_last() {
        let a = [row("x", "2026-10-29T08:00:00Z", json!({})), row("bad", "not a date", json!({}))];
        let b = [
            row("x", "2026-10-29T09:00:00+00:00", json!({ "loginId": "b", "title": "newer" })),
            row("y", "2026-10-29T08:30:00Z", json!({})),
        ];
        let merged = merge_artifacts([&a[..], &b[..]]);
        let got: Vec<_> = merged.iter().map(|a| (a.slug.as_str(), a.title.as_str())).collect();
        assert_eq!(got, [("x", "newer"), ("y", "y"), ("bad", "bad")]);
    }

    #[test]
    fn the_owners_row_wins_over_a_shared_one() {
        let a = [
            row("x", "2026-10-29T08:00:00Z", json!({ "rel": "shared" })),
            row("old", "2026-10-01T00:00:00Z", json!({})),
        ];
        let b = [
            row("x", "2026-10-29T08:00:00Z", json!({ "loginId": "b" })),
            row("new", "2026-10-29T11:00:00Z", json!({ "loginId": "b" })),
        ];
        let merged = merge_artifacts([&a[..], &b[..]]);
        let got: Vec<_> = merged.iter().map(|a| (a.slug.as_str(), a.login_id.as_str(), a.rel)).collect();
        assert_eq!(
            got,
            [
                ("new", "b", ArtifactSummaryRel::Mine),
                ("x", "b", ArtifactSummaryRel::Mine),
                ("old", "a", ArtifactSummaryRel::Mine)
            ]
        );
    }

    fn result(content: &str) -> AgentEvent {
        serde_json::from_value(json!({
            "type": "message", "role": "tool",
            "blocks": [{ "type": "tool_result", "callId": "c1", "isError": false, "content": content }],
        }))
        .unwrap()
    }

    // "announcesArtifact"
    #[test]
    fn matches_a_tool_result_holding_a_claude_ai_artifact_link_in_either_form() {
        assert!(announces_artifact(&result("Published: https://claude.ai/artifact/BLUSnX4ryWVrJkeDQtv9mP")));
        assert!(announces_artifact(&result("https://claude.ai/code/artifact/0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b")));
        assert!(announces_artifact(&result("see https://preview.claude.com/artifact/abc")));
    }

    #[test]
    fn ignores_other_links_other_blocks_and_other_events() {
        assert!(!announces_artifact(&result("https://claude.ai/chat/123 and http://claude.ai/artifact/x")));
        let text: AgentEvent = serde_json::from_value(json!({
            "type": "message", "role": "assistant",
            "blocks": [{ "type": "text", "text": "https://claude.ai/artifact/BLUSnX4ryWVrJkeDQtv9mP" }],
        }))
        .unwrap();
        assert!(!announces_artifact(&text));
        let turn: AgentEvent = serde_json::from_value(json!({ "type": "turn", "phase": "ended" })).unwrap();
        assert!(!announces_artifact(&turn));
    }
}
