//! The event stream (`GET /stream`): what its frames carry.
//!
//! Three server-sent events, each with `id: <epoch>-<seq>`
//! (`manager/sse/SseBroadcaster.ts`):
//! - `hello` when a client connects and `resync` when the ring no longer
//!   covers its `?since=`: [`StreamSync`];
//! - `change` for every bus message: [`StreamChange`].
//!
//! Payloads with a type here: `fs:change` [`FsChangeEvent`](crate::FsChangeEvent),
//! `git:change` [`GitChangeEvent`](crate::GitChangeEvent), `pages:change`
//! [`PageChangeEvent`](crate::PageChangeEvent), `profile:change`
//! [`UserProfileChangeEvent`](crate::UserProfileChangeEvent), `user-memory:change`
//! [`UserMemoryChangeEvent`](crate::UserMemoryChangeEvent), `jobs:change`
//! [`BackgroundJobChange`](crate::BackgroundJobChange), `genui:change`
//! [`GenuiChange`](crate::GenuiChange), `genui:delta` [`GenuiDelta`](crate::GenuiDelta),
//! `pty:session` [`PtySession`](crate::PtySession), `loop:check`
//! [`LoopCheckProgress`](crate::LoopCheckProgress), `workflow:progress`
//! [`WorkflowRunProgress`](crate::WorkflowRunProgress), `transfer:change`
//! [`TransferChangeEvent`](crate::TransferChangeEvent), `dream:change`
//! [`DreamChangeEvent`](crate::DreamChangeEvent), `update:change`
//! [`UpdateState`](crate::UpdateState), `update:apply` [`UpdateApply`](crate::UpdateApply).
//! The other topics carry shapes their publisher owns.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::primitives::de;

/// Data of a `hello` or `resync` frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StreamSync {
    /// Changes on every start: a client holding another epoch must reload.
    pub epoch: String,
    pub seq: i64,
    /// What this stream offers beyond plain change pings (`state:patch`).
    pub caps: Vec<String>,
}

/// Data of a `change` frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StreamChange {
    /// The bus topic.
    pub reason: String,
    /// Epoch milliseconds when the frame was written.
    pub ts: i64,
    /// Absent when the publisher sent none.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
    pub payload: Option<Value>,
}

/// The kernel's bus topics (`core/src/ports/EventBus.ts`); a feature names its own.
pub mod topics {
    pub const WORKER_CHANGE: &str = "worker:change";
    pub const WORKER_SPAWN: &str = "worker:spawn";
    pub const WORKER_EXIT: &str = "worker:exit";
    pub const WORKER_REMOVED: &str = "worker:removed";
    pub const WORKER_REPORT: &str = "worker:report";
    pub const POLICY_DECISION: &str = "policy:decision";
    pub const PENDING_CREATED: &str = "pending:created";
    pub const PENDING_RESOLVED: &str = "pending:resolved";
    pub const USAGE_RECORDED: &str = "usage:recorded";
    pub const USAGE_CHANGE: &str = "usage:change";
    pub const NOTIFICATION_FIRE: &str = "notification:fire";
    pub const TERMINAL_START: &str = "terminal:start";
    pub const TERMINAL_CHUNK: &str = "terminal:chunk";
    pub const TERMINAL_DONE: &str = "terminal:done";
    pub const PTY_DATA: &str = "pty:data";
    pub const PTY_EXIT: &str = "pty:exit";
    pub const PTY_SESSION: &str = "pty:session";
    pub const PTY_CONVERSATION: &str = "pty:conversation";
    pub const AGENT_DELTA: &str = "agent:delta";
    pub const MESSAGE_RECALLED: &str = "message:recalled";
    pub const LOOP_CHANGE: &str = "loop:change";
    pub const LOOP_CHECK: &str = "loop:check";
    pub const FS_CHANGE: &str = "fs:change";
    pub const GIT_CHANGE: &str = "git:change";
    pub const PEER_PRESENCE: &str = "peer:presence";
    pub const HOSTS_CHANGE: &str = "hosts:change";
    pub const PAGES_CHANGE: &str = "pages:change";
    pub const PROFILE_CHANGE: &str = "profile:change";
    pub const USER_MEMORY_CHANGE: &str = "user-memory:change";
    pub const JOBS_CHANGE: &str = "jobs:change";
    pub const PLUGINS_CHANGE: &str = "plugins:change";
    pub const STATE_PATCH: &str = "state:patch";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_round_trip() {
        // manager/sse/SseBroadcaster.ts: helloFrame() and broadcast().
        let hello = json!({"epoch": "19a2b3c4d5e6", "seq": 12, "caps": ["state:patch"]});
        assert_eq!(serde_json::to_value(serde_json::from_value::<StreamSync>(hello.clone()).unwrap()).unwrap(), hello);
        for change in [
            json!({"reason": "worker:change", "ts": 1_700_000_000_000_i64, "payload": {"workerId": "w-1"}}),
            json!({"reason": "usage:change", "ts": 1}),
            json!({"reason": "x", "ts": 1, "payload": null}),
        ] {
            assert_eq!(
                serde_json::to_value(serde_json::from_value::<StreamChange>(change.clone()).unwrap()).unwrap(),
                change
            );
        }
    }
}
