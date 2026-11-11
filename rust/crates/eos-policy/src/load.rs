//! From the policy document to the policy in force, and the one edit the app
//! makes to the user's file (`infra/src/policy/YamlPolicyLoader.ts`,
//! `manager/routes/policy.ts`).

use eos_contracts::PolicyBehavior;
use eos_core::policy::PolicyDocument;
use serde_json::{Map, Value, json};

use crate::rule::{Policy, compile_rule};

fn behavior(name: &str) -> Option<PolicyBehavior> {
    match name {
        "allow" => Some(PolicyBehavior::Allow),
        "deny" => Some(PolicyBehavior::Deny),
        "ask" => Some(PolicyBehavior::Ask),
        "rewrite" => Some(PolicyBehavior::Rewrite),
        _ => None,
    }
}

pub(crate) fn behavior_name(behavior: PolicyBehavior) -> &'static str {
    match behavior {
        PolicyBehavior::Allow => "allow",
        PolicyBehavior::Deny => "deny",
        PolicyBehavior::Ask => "ask",
        PolicyBehavior::Rewrite => "rewrite",
    }
}

/// Builds the policy in force. A missing file or one that does not parse asks
/// about everything; a rule that cannot be compiled is dropped (and logged),
/// the rest apply. `default_ttl_ms` stands in for a file without `ttlMs`.
pub fn load_policy(document: PolicyDocument, default_ttl_ms: i64) -> Policy {
    let (source, value) = match document {
        PolicyDocument::Missing => {
            tracing::info!("no policy file found; default=ask, no rules");
            return Policy::ask_everything(default_ttl_ms);
        }
        PolicyDocument::Unreadable { source, error } => {
            tracing::warn!(%source, %error, "failed to parse policy file");
            return Policy::ask_everything(default_ttl_ms);
        }
        PolicyDocument::Parsed { source, value } => (source, value),
    };

    // `rules` that is not a list holds no rules.
    let authored = value.get("rules").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut log = |message: String| tracing::warn!("{message}");
    let rules: Vec<_> =
        authored.iter().enumerate().filter_map(|(idx, rule)| compile_rule(rule, idx, &source, &mut log)).collect();
    tracing::info!(%source, applied = rules.len(), total = authored.len(), "policy loaded");

    let default = match value.get("default") {
        None | Some(Value::Null) => PolicyBehavior::Ask,
        Some(given) => given.as_str().and_then(behavior).unwrap_or_else(|| {
            tracing::warn!(%source, value = %crate::js::to_string(given), "invalid policy default; using ask");
            PolicyBehavior::Ask
        }),
    };
    // Any number counts, as in `typeof ttlMs === "number"`.
    #[allow(clippy::cast_possible_truncation)]
    let ttl_ms = value.get("ttlMs").and_then(Value::as_f64).map_or(default_ttl_ms, |ttl| ttl as i64);
    Policy { default, ttl_ms, rules }
}

/// The user's policy document with a rule for `tool` appended; `None` when a
/// rule naming exactly that tool is there already. The document keeps its
/// `default` (ask when it has none), its `ttlMs` and its rules; nothing else.
pub fn with_tool_rule(document: Option<&Value>, tool: &str, action: PolicyBehavior) -> Option<Value> {
    let empty = Map::new();
    let root = document.and_then(Value::as_object).unwrap_or(&empty);
    let rules = root.get("rules").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    if rules.iter().any(|rule| rule.get("tool").and_then(Value::as_str) == Some(tool)) {
        return None;
    }
    let mut next = Map::new();
    next.insert("default".to_owned(), root.get("default").filter(|v| !v.is_null()).cloned().unwrap_or(json!("ask")));
    if let Some(ttl) = root.get("ttlMs") {
        next.insert("ttlMs".to_owned(), ttl.clone());
    }
    let mut all = rules.to_vec();
    all.push(json!({ "tool": tool, "action": behavior_name(action) }));
    next.insert("rules".to_owned(), Value::Array(all));
    Some(Value::Object(next))
}

#[cfg(test)]
mod tests {
    use eos_contracts::{Decision, UnknownRecord};

    use super::*;
    use crate::rule::evaluate_policy;

    fn parsed(value: Value) -> PolicyDocument {
        PolicyDocument::Parsed { source: "policy.yaml".into(), value }
    }

    #[test]
    fn a_missing_or_broken_file_asks_about_everything() {
        for document in
            [PolicyDocument::Missing, PolicyDocument::Unreadable { source: "p".into(), error: "bad".into() }]
        {
            let policy = load_policy(document, 7);
            assert_eq!((policy.default, policy.ttl_ms, policy.rules.len()), (PolicyBehavior::Ask, 7, 0));
        }
    }

    #[test]
    fn defaults_ttl_and_rules_are_read_leniently() {
        let policy = load_policy(
            parsed(json!({
                "default": "allow",
                "ttlMs": 3000,
                "rules": [{"tool": "Bash", "action": "deny"}, {"tool": "Bash", "x": "(", "action": "allow"}, null],
            })),
            0,
        );
        assert_eq!((policy.default, policy.ttl_ms, policy.rules.len()), (PolicyBehavior::Allow, 3000, 1));

        let policy = load_policy(parsed(json!({"default": "sometimes", "ttlMs": "soon", "rules": "none"})), 9);
        assert_eq!((policy.default, policy.ttl_ms, policy.rules.len()), (PolicyBehavior::Ask, 9, 0));

        let empty_file = load_policy(parsed(Value::Null), 0);
        assert_eq!((empty_file.default, empty_file.rules.len()), (PolicyBehavior::Ask, 0));
    }

    #[test]
    fn a_saved_rule_is_one_the_engine_honours() {
        let saved = with_tool_rule(None, "mcp__demo__do", PolicyBehavior::Allow).expect("added");
        assert_eq!(saved, json!({"default": "ask", "rules": [{"tool": "mcp__demo__do", "action": "allow"}]}));
        let policy = load_policy(parsed(saved.clone()), 0);
        assert!(matches!(evaluate_policy(&policy, "mcp__demo__do", &UnknownRecord::new()), Decision::Allow(_)));

        assert_eq!(with_tool_rule(Some(&saved), "mcp__demo__do", PolicyBehavior::Deny), None, "one rule per tool");
    }

    #[test]
    fn saving_keeps_the_default_the_ttl_and_the_rules_and_drops_the_rest() {
        let document = json!({
            "default": "allow",
            "ttlMs": 3000,
            "note": "dropped",
            "rules": [{"tool": ["Bash", "Read"], "action": "allow"}],
        });
        let saved = with_tool_rule(Some(&document), "Bash", PolicyBehavior::Deny).expect("a list is not that tool");
        assert_eq!(
            serde_json::to_string(&saved).expect("json"),
            r#"{"default":"allow","ttlMs":3000,"rules":[{"tool":["Bash","Read"],"action":"allow"},{"tool":"Bash","action":"deny"}]}"#
        );
    }
}
