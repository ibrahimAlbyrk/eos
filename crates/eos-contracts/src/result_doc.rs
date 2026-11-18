//! A routine run's result as parts with stable keys, and an edit of one as
//! changes to its parts. Shapes only; the parts each kind has, when two
//! results are the same and how one became another are
//! `eos_domain::result_doc`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::validate::Validate;

/// `{"kind": "github.review", "channel": "github", "action": "post_review", "parts": [..]}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ResultDoc {
    /// What the result is, which decides its parts (`github.review`, `mail`).
    pub kind: String,
    /// The channel that delivers it.
    pub channel: String,
    /// The channel's action that delivers it.
    pub action: String,
    pub parts: Vec<Part>,
}

impl Validate for ResultDoc {}

/// One piece of a result: a review's summary, one of its line comments, a
/// mail's paragraph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Part {
    /// Stable through edits, unique in its result (`summary`, `c:2`).
    pub key: String,
    /// What the part is to its result, for the editor (`comment`).
    pub role: String,
    pub text: String,
    /// What else the part needs: a line comment's path, line and side.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub meta: Map<String, Value>,
}

impl Validate for Part {}

/// One part's change between two versions of a result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PartEdit {
    pub key: String,
    pub op: EditOp,
    /// The part as it was; none for an added part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Part>,
    /// The part as it is; none for a removed part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<Part>,
}

impl Validate for PartEdit {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum EditOp {
    Changed,
    Removed,
    Added,
    /// The same part, elsewhere among parts whose order counts.
    Moved,
}

impl Validate for EditOp {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_result_and_its_edits_read_and_write_back_ignoring_unknown_keys() {
        let doc = json!({
            "kind": "github.review",
            "channel": "github",
            "action": "post_review",
            "parts": [
                {"key": "event", "role": "event", "text": "COMMENT"},
                {"key": "c:1", "role": "comment", "text": "Off by one.",
                 "meta": {"path": "src/net.rs", "line": 42, "side": "RIGHT"}},
            ],
        });
        let mut newer = doc.clone();
        newer["headline"] = json!("Two comments");
        newer["parts"][0]["locked"] = json!(true);
        let read: ResultDoc = crate::parse(&newer).unwrap();
        assert_eq!(read.parts[1].meta["line"], json!(42));
        assert_eq!(serde_json::to_value(&read).unwrap(), doc, "fields in the declared order, an empty meta left out");

        let edit = json!({"key": "c:1", "op": "removed", "before": doc["parts"][1]});
        let read: PartEdit = crate::parse(&edit).unwrap();
        assert_eq!((read.op, &read.after), (EditOp::Removed, &None));
        assert_eq!(serde_json::to_value(&read).unwrap(), edit);
        assert!(crate::parse::<PartEdit>(&json!({"key": "c:1", "op": "renamed"})).is_err());
    }
}
