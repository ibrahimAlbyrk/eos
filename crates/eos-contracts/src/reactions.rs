//! Emoji reactions on a chat's messages (`/workers/:id/reactions`): the
//! user's on any message, the agent's on the user's. One per actor per
//! message. Routes of the Rust core only.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::{Issues, Validate};

/// The longest emoji a reaction takes, in bytes (a family or a flag sequence fits).
pub const REACTION_EMOJI_MAX_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReactionActor {
    User,
    Agent,
}

impl ReactionActor {
    pub fn as_str(self) -> &'static str {
        match self {
            ReactionActor::User => "user",
            ReactionActor::Agent => "agent",
        }
    }
}

impl Validate for ReactionActor {}

/// One reaction on a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    /// The message's row.
    pub row_id: i64,
    pub actor: ReactionActor,
    pub emoji: String,
    pub at: i64,
    /// The user's only: the agent has been told about it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<bool>,
}

impl Validate for Reaction {}

/// `GET /workers/:id/reactions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReactionsResponse {
    pub reactions: Vec<Reaction>,
}

impl Validate for ReactionsResponse {}

/// `PUT /workers/:id/reactions/:rowId`: the user's reaction on that message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SetReactionRequest {
    pub emoji: String,
}

impl Validate for SetReactionRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("emoji", |cx| {
            cx.str_min(&self.emoji, 1);
            if self.emoji.len() > REACTION_EMOJI_MAX_BYTES {
                cx.push("is too long for an emoji");
            }
        });
    }
}

/// The answer to a reaction the user set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetReactionResponse {
    #[serde(flatten)]
    pub reaction: Reaction,
    /// Set when the reaction starts a turn of the agent after this long,
    /// unless it changes first; otherwise it goes with the user's next message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wakes_in_ms: Option<i64>,
}

impl Validate for SetReactionResponse {}

/// `DELETE /workers/:id/reactions/:rowId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReactionRemoved {
    pub removed: bool,
}

impl Validate for ReactionRemoved {}

/// `reactions:change`: a reaction was set, taken back (`emoji` is null) or
/// the agent was told about it (`seen`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionChange {
    pub worker_id: String,
    pub row_id: i64,
    pub actor: ReactionActor,
    pub emoji: Option<String>,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<bool>,
}

impl Validate for ReactionChange {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_reaction_reads_as_the_dashboard_expects() {
        let mine = Reaction { row_id: 812, actor: ReactionActor::User, emoji: "👍".into(), at: 5, seen: Some(false) };
        let set = SetReactionResponse { reaction: mine.clone(), wakes_in_ms: Some(2000) };
        assert_eq!(
            serde_json::to_value(&set).unwrap(),
            json!({"rowId": 812, "actor": "user", "emoji": "👍", "at": 5, "seen": false, "wakesInMs": 2000})
        );
        let theirs = Reaction { row_id: 7, actor: ReactionActor::Agent, emoji: "❤️".into(), at: 6, seen: None };
        assert_eq!(
            serde_json::to_value(&theirs).unwrap(),
            json!({"rowId": 7, "actor": "agent", "emoji": "❤️", "at": 6})
        );
        let gone = ReactionChange {
            worker_id: "w-1".into(),
            row_id: 7,
            actor: ReactionActor::Agent,
            emoji: None,
            at: 9,
            seen: None,
        };
        assert_eq!(
            serde_json::to_value(&gone).unwrap(),
            json!({"workerId": "w-1", "rowId": 7, "actor": "agent", "emoji": null, "at": 9})
        );
    }

    #[test]
    fn a_request_needs_an_emoji_of_a_sane_length() {
        assert!(crate::parse::<SetReactionRequest>(&json!({"emoji": "👍"})).is_ok());
        assert!(crate::parse::<SetReactionRequest>(&json!({"emoji": ""})).is_err());
        assert!(crate::parse::<SetReactionRequest>(&json!({"emoji": "x".repeat(65)})).is_err());
        assert!(crate::parse::<SetReactionRequest>(&json!({})).is_err());
    }
}
