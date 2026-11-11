//! Messages waiting for a worker that is busy.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Who a queued message is from. Only the user's own show in their composer;
/// an agent's (a report waiting for a busy parent) drain into the transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MessagePlane {
    #[default]
    User,
    Agent,
}

impl MessagePlane {
    pub fn name(self) -> &'static str {
        match self {
            MessagePlane::User => "user",
            MessagePlane::Agent => "agent",
        }
    }
}

/// What travels with a queued message besides its text. Stored as one JSON
/// object, absent keys left out; the parts are their owners' shapes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMeta {
    /// Who sends it and how it is wrapped for the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envelope: Option<Value>,
    /// What the composer shows instead of the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Value>,
}

impl QueueMeta {
    pub fn is_empty(&self) -> bool {
        self.envelope.is_none() && self.display_text.is_none() && self.reply_to.is_none() && self.action.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueuedMessage {
    pub id: i64,
    pub worker_id: String,
    /// The sender's own id for the message: a second send of it is ignored.
    pub client_msg_id: Option<String>,
    pub text: String,
    pub created_at: i64,
    pub meta: QueueMeta,
}
