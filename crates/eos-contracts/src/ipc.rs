use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::str_lit;
use crate::validate::{Issues, Validate};

str_lit!(pub OneLit = "1");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerMessageBody {
    pub text: String,
}

impl Validate for WorkerMessageBody {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| cx.str_min(&self.text, 1));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerMessageReply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for WorkerMessageReply {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkerHookReply {
    pub r#continue: bool,
}

impl Validate for WorkerHookReply {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DaemonAwareEnv {
    #[serde(rename = "EOS_SPAWNED")]
    pub eos_spawned: OneLit,
    #[serde(rename = "EOS_WORKER_ID")]
    pub eos_worker_id: String,
    #[serde(rename = "EOS_DAEMON_URL")]
    pub eos_daemon_url: String,
}

impl Validate for DaemonAwareEnv {
    fn validate(&self, cx: &mut Issues) {
        cx.at("EOS_DAEMON_URL", |cx| cx.url(&self.eos_daemon_url));
    }
}
