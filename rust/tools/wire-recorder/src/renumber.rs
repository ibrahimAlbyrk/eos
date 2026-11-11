//! Renumbers `<kind:N>` tokens by first sight.
//!
//! A recording numbers generated ids in the order the whole scenario met them.
//! A target that does not serve every step yet meets them in another order,
//! so the same id carries another number on its side. Renumbering both sides
//! over the steps that are compared makes the numbers mean the same again:
//! two documents then match when the same ids sit in the same places.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

static TOKEN: LazyLock<Regex> = LazyLock::new(|| match Regex::new(r"<([a-z-]+):\d+>") {
    Ok(re) => re,
    Err(e) => panic!("the token pattern does not compile: {e}"),
});

/// One side's numbering, kept across the steps of a scenario.
#[derive(Debug, Default)]
pub struct Renumber {
    seen: HashMap<String, String>,
    counters: HashMap<String, usize>,
}

impl Renumber {
    fn text(&mut self, text: &str) -> String {
        let Self { seen, counters } = self;
        TOKEN
            .replace_all(text, |found: &regex::Captures<'_>| {
                seen.entry(found[0].to_owned())
                    .or_insert_with(|| {
                        let n = counters.entry(found[1].to_owned()).or_insert(0);
                        *n += 1;
                        format!("<{}:{n}>", &found[1])
                    })
                    .clone()
            })
            .into_owned()
    }

    /// `value` with its tokens renumbered. Object keys are visited in an order
    /// that does not depend on the numbers themselves.
    pub fn apply(&mut self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.apply(item)).collect()),
            Value::Object(fields) => {
                let mut keys: Vec<&String> = fields.keys().collect();
                keys.sort_by_cached_key(|key| TOKEN.replace_all(key, "<$1>").into_owned());
                keys.into_iter()
                    .map(|key| (self.text(key), self.apply(&fields[key])))
                    .collect::<serde_json::Map<_, _>>()
                    .into()
            }
            other => other.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_same_ids_in_the_same_places_get_the_same_numbers() {
        // The recording met two other workers before these; the target did not.
        let recorded = json!({ "rows": [{ "id": "<worker:3>", "parent": "<orchestrator:1>" }, { "id": "<worker:4>", "note": "see <worker:3>" }] });
        let actual = json!({ "rows": [{ "id": "<worker:1>", "parent": "<orchestrator:1>" }, { "id": "<worker:2>", "note": "see <worker:1>" }] });
        assert_eq!(Renumber::default().apply(&recorded), Renumber::default().apply(&actual));

        let swapped = json!({ "rows": [{ "id": "<worker:1>", "parent": "<orchestrator:1>" }, { "id": "<worker:2>", "note": "see <worker:2>" }] });
        assert_ne!(
            Renumber::default().apply(&recorded),
            Renumber::default().apply(&swapped),
            "a different id in one place still differs"
        );
    }

    #[test]
    fn numbering_carries_over_to_later_steps_and_leaves_other_placeholders_alone() {
        let mut side = Renumber::default();
        assert_eq!(side.apply(&json!(["<uuid:9>", "<now>", "<count>"])), json!(["<uuid:1>", "<now>", "<count>"]));
        assert_eq!(side.apply(&json!({ "<uuid:9>": "<uuid:5>" })), json!({ "<uuid:1>": "<uuid:2>" }));
    }
}
