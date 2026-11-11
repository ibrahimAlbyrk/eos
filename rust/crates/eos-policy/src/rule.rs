//! `policy.yaml` rules: compiling them once and walking them in order
//! (`core/src/domain/policy.ts`).
//!
//! A rule is a mapping. `tool` (a name or a list), `action`, `reason` and the
//! three `rewrite*` keys are its own; every other key is a matcher: a
//! JavaScript regex tested against the call's input field of that name.

use eos_contracts::{AllowVariant, Decision, DenyVariant, PolicyBehavior, UnknownRecord};
use serde_json::{Map, Value};

use crate::js::{self, JsRegex};

const RESERVED_RULE_KEYS: &[&str] = &["tool", "action", "reason", "rewriteField", "rewriteFrom", "rewriteTo"];

/// What a matching rule does.
#[derive(Debug, Clone)]
enum Action {
    Allow,
    Deny {
        reason: Option<String>,
    },
    Ask,
    /// Allows the call with `field` rewritten: the first match of `from`
    /// replaced by `to` (JavaScript's `replace`).
    Rewrite {
        field: String,
        from: JsRegex,
        to: String,
    },
    /// An action the engine does not know (`permit`, a missing one): the rule
    /// still matches, but decides nothing and the walk goes on.
    Unknown,
}

/// A rule ready to match.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    /// `None`: any tool.
    tools: Option<Vec<String>>,
    matchers: Vec<(String, JsRegex)>,
    action: Action,
}

/// The policy in force.
#[derive(Debug, Clone)]
pub struct Policy {
    /// What happens to a call no rule and no mode decided.
    pub default: PolicyBehavior,
    /// How long an ask is good for, in milliseconds; 0 means a day. It only
    /// stamps the pending row's `expires_at`.
    pub ttl_ms: i64,
    pub rules: Vec<CompiledRule>,
}

impl Policy {
    /// No file, or one that does not parse: ask about everything.
    pub fn ask_everything(ttl_ms: i64) -> Self {
        Self { default: PolicyBehavior::Ask, ttl_ms, rules: Vec::new() }
    }

    /// Whether any rule matches the call.
    pub fn has_rule_for(&self, tool_name: &str, input: &UnknownRecord) -> bool {
        self.rules.iter().any(|rule| rule.matches(tool_name, input))
    }
}

/// Compiles one authored rule; `None` (with the reason handed to `log`) when
/// it cannot be used and must be dropped: a matcher or `rewriteFrom` that is
/// not a JavaScript regex, a rewrite without `rewriteFrom` / `rewriteTo`, or
/// a rule that is not a mapping.
pub fn compile_rule(rule: &Value, idx: usize, source: &str, log: &mut dyn FnMut(String)) -> Option<CompiledRule> {
    let Some(rule) = rule.as_object() else {
        log(format!("policy rule {idx} ({source}) is not a mapping — dropping rule"));
        return None;
    };
    let tools = rule.get("tool").filter(|tool| js::truthy(tool)).map(tool_set);

    let mut matchers = Vec::new();
    for (key, value) in rule {
        if RESERVED_RULE_KEYS.contains(&key.as_str()) {
            continue;
        }
        match JsRegex::new(&js::to_string(value)) {
            Ok(re) => matchers.push((key.clone(), re)),
            Err(e) => {
                log(format!("policy rule {idx} ({source}) has invalid regex for \"{key}\": {e} — dropping rule"));
                return None;
            }
        }
    }

    let action = match rule.get("action").and_then(Value::as_str) {
        Some("allow") => Action::Allow,
        Some("deny") => Action::Deny { reason: text(rule, "reason") },
        Some("ask") => Action::Ask,
        Some("rewrite") => {
            let (Some(from), Some(to)) = (truthy_text(rule, "rewriteFrom"), truthy_text(rule, "rewriteTo")) else {
                log(format!("policy rule {idx} ({source}) action=rewrite missing rewriteFrom/rewriteTo — dropping"));
                return None;
            };
            match JsRegex::new(&from) {
                Ok(from) => Action::Rewrite {
                    field: text(rule, "rewriteField").unwrap_or_else(|| "command".to_owned()),
                    from,
                    to,
                },
                Err(e) => {
                    log(format!("policy rule {idx} ({source}) bad rewriteFrom regex: {e} — dropping"));
                    return None;
                }
            }
        }
        _ => Action::Unknown,
    };
    Some(CompiledRule { tools, matchers, action })
}

/// The names a rule's `tool` lists. Only strings can equal a tool's name.
fn tool_set(tool: &Value) -> Vec<String> {
    match tool {
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        Value::String(name) => vec![name.clone()],
        _ => Vec::new(),
    }
}

/// A key's value as text; `None` when absent or null (`??`).
fn text(rule: &Map<String, Value>, key: &str) -> Option<String> {
    rule.get(key).filter(|v| !v.is_null()).map(js::to_string)
}

/// A key's value as text when it is truthy.
fn truthy_text(rule: &Map<String, Value>, key: &str) -> Option<String> {
    rule.get(key).filter(|v| js::truthy(v)).map(js::to_string)
}

/// `String(input[key] ?? "")`.
fn field_text(input: &UnknownRecord, key: &str) -> String {
    input.get(key).filter(|v| !v.is_null()).map(js::to_string).unwrap_or_default()
}

impl CompiledRule {
    /// Whether the rule is about this call: its tool is listed (or the rule
    /// lists none) and every matcher finds its pattern in the input field. A
    /// missing field is the empty string.
    pub fn matches(&self, tool_name: &str, input: &UnknownRecord) -> bool {
        self.tools.as_ref().is_none_or(|tools| tools.iter().any(|tool| tool == tool_name))
            && self.matchers.iter().all(|(key, re)| re.test(&field_text(input, key)))
    }
}

fn allow(input: UnknownRecord) -> Decision {
    Decision::Allow(AllowVariant { updated_input: Some(input), message: None })
}

fn deny(message: impl Into<String>) -> Decision {
    Decision::Deny(DenyVariant { message: message.into() })
}

/// Walks the rules in order; the first matching rule with a known action
/// decides. With none, the policy's default. An allow carries the input to
/// run with: the call's own, or the rewritten one.
pub fn evaluate_policy(policy: &Policy, tool_name: &str, input: &UnknownRecord) -> Decision {
    for rule in policy.rules.iter().filter(|rule| rule.matches(tool_name, input)) {
        match &rule.action {
            Action::Allow => return allow(input.clone()),
            Action::Deny { reason } => return deny(reason.as_deref().unwrap_or("denied by policy")),
            Action::Ask => return Decision::Ask,
            Action::Rewrite { field, from, to } => {
                let next = from.replace(&field_text(input, field), to);
                let mut updated = input.clone();
                updated.insert(field.clone(), Value::String(next));
                return allow(updated);
            }
            Action::Unknown => {}
        }
    }
    match policy.default {
        PolicyBehavior::Allow => allow(input.clone()),
        PolicyBehavior::Deny => deny("no rule matched (default deny)"),
        PolicyBehavior::Ask | PolicyBehavior::Rewrite => Decision::Ask,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn record(value: Value) -> UnknownRecord {
        serde_json::from_value(value).expect("an object")
    }

    fn compile(rules: Value) -> Policy {
        let rules = rules
            .as_array()
            .expect("a list")
            .iter()
            .enumerate()
            .filter_map(|(i, rule)| compile_rule(rule, i, "<test>", &mut |_| {}))
            .collect();
        Policy { default: PolicyBehavior::Ask, ttl_ms: 30_000, rules }
    }

    fn one(rule: Value) -> Option<CompiledRule> {
        compile_rule(&rule, 0, "x", &mut |_| {})
    }

    #[test]
    fn a_rule_that_cannot_be_used_is_dropped_and_logged() {
        assert!(one(json!({"tool": "Bash", "action": "deny", "command": "([invalid"})).is_none());
        assert!(one(json!({"tool": "Bash", "action": "rewrite"})).is_none());
        assert!(one(json!({"tool": "Bash", "action": "rewrite", "rewriteFrom": "([bad", "rewriteTo": "x"})).is_none());
        assert!(one(json!({"tool": "Bash", "action": "allow", "command": "ls"})).is_some());

        let mut logs = Vec::new();
        let rule = json!({"tool": "Bash", "action": "deny", "command": "([bad"});
        assert!(compile_rule(&rule, 5, "policy.yaml", &mut |m| logs.push(m)).is_none());
        assert_eq!(logs.len(), 1);
        assert!(logs[0].starts_with("policy rule 5 (policy.yaml) has invalid regex for \"command\""), "{}", logs[0]);
    }

    #[test]
    fn matching_on_the_tool_list_and_on_fields() {
        let listed = one(json!({"tool": ["Bash", "Read"], "action": "allow"})).expect("compiles");
        assert!(listed.matches("Bash", &record(json!({}))));
        assert!(listed.matches("Read", &record(json!({}))));
        assert!(!listed.matches("Edit", &record(json!({}))));

        let field = one(json!({"tool": "Bash", "action": "deny", "command": "^rm\\s"})).expect("compiles");
        assert!(field.matches("Bash", &record(json!({"command": "rm -rf /"}))));
        assert!(!field.matches("Bash", &record(json!({"command": "ls -la"}))));

        let needs_text = one(json!({"tool": "Bash", "action": "deny", "command": ".+"})).expect("compiles");
        assert!(!needs_text.matches("Bash", &record(json!({}))), "a missing field is the empty string");
    }

    #[test]
    fn the_first_matching_rule_decides_then_the_default() {
        let policy = compile(json!([{"tool": "Read", "action": "allow"}]));
        assert!(matches!(evaluate_policy(&policy, "Read", &record(json!({}))), Decision::Allow(_)));

        let policy = compile(json!([{"tool": "Bash", "action": "deny", "reason": "nope", "command": "^rm"}]));
        assert_eq!(evaluate_policy(&policy, "Bash", &record(json!({"command": "rm -rf /"}))), deny("nope"));

        let policy = compile(json!([{"tool": "Edit", "action": "allow"}, {"tool": "Bash", "action": "deny"}]));
        assert_eq!(evaluate_policy(&policy, "Bash", &record(json!({}))), deny("denied by policy"));

        let mut policy = compile(json!([{"tool": "Read", "action": "allow"}]));
        assert_eq!(evaluate_policy(&policy, "Bash", &record(json!({}))), Decision::Ask);
        policy.default = PolicyBehavior::Allow;
        assert!(matches!(evaluate_policy(&policy, "Bash", &record(json!({}))), Decision::Allow(_)));
        policy.default = PolicyBehavior::Deny;
        assert_eq!(evaluate_policy(&policy, "Bash", &record(json!({}))), deny("no rule matched (default deny)"));
    }

    #[test]
    fn a_rewrite_rule_allows_with_the_field_rewritten_in_place() {
        let policy = compile(json!([{
            "tool": "Bash",
            "action": "rewrite",
            "command": "(^|\\s)curl(?!.*--max-time)",
            "rewriteField": "command",
            "rewriteFrom": "(^|\\s)curl\\b",
            "rewriteTo": "$1curl --max-time 10",
        }]));
        let input = record(json!({"command": "curl https://example.com", "description": "fetch"}));
        let Decision::Allow(allowed) = evaluate_policy(&policy, "Bash", &input) else { panic!("allowed") };
        assert_eq!(
            serde_json::to_string(&allowed.updated_input).expect("json"),
            r#"{"command":"curl --max-time 10 https://example.com","description":"fetch"}"#
        );
    }

    #[test]
    fn a_dropped_rule_never_decides() {
        let policy = compile(
            json!([{"tool": "Bash", "action": "deny", "command": "([invalid"}, {"tool": "Bash", "action": "allow"}]),
        );
        assert_eq!(policy.rules.len(), 1);
        assert!(matches!(
            evaluate_policy(&policy, "Bash", &record(json!({"command": "anything"}))),
            Decision::Allow(_)
        ));
    }

    #[test]
    fn a_rule_with_an_unknown_action_matches_but_leaves_the_decision_to_what_follows() {
        let policy = compile(json!([{"tool": "Bash", "action": "permit"}, {"tool": "Bash", "action": "deny"}]));
        assert!(policy.has_rule_for("Bash", &record(json!({}))));
        assert_eq!(evaluate_policy(&policy, "Bash", &record(json!({}))), deny("denied by policy"));
    }
}
