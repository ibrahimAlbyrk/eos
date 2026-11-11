//! Who a message to an agent is from, and how it is wrapped for the model
//! (`core/src/domain/message-envelope.ts`, `sender-tag.ts`).
//!
//! The operator's own words go to the model as typed. Anything else is
//! wrapped in a tag that says who sent it: another agent
//! (`<agent_message>`) or Eos itself (`<system_message>`).

use serde::{Deserialize, Serialize};

/// What a dispatched message is, when it is not the operator's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Envelope {
    OrchestratorMessage {
        from_parent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_name: Option<String>,
    },
    WorkerReport {
        /// `system`: Eos reports for the worker (it ended without reporting).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provenance: Option<String>,
        from_worker: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worker_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worktree_dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
    },
    PeerRequest {
        from_worker: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_name: Option<String>,
    },
    Loop {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt: Option<i64>,
    },
    ReportReminder,
    PermissionAsk {
        pending_id: String,
        from_worker: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worker_name: Option<String>,
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_summary: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires_at: Option<i64>,
    },
    ContextThreshold {
        stage: String,
        from_worker: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worker_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pct: Option<f64>,
    },
}

impl Envelope {
    /// The `kind` on the wire; also the reason of the state change it causes.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::OrchestratorMessage { .. } => "orchestrator_message",
            Self::WorkerReport { .. } => "worker_report",
            Self::PeerRequest { .. } => "peer_request",
            Self::Loop { .. } => "loop",
            Self::ReportReminder => "report_reminder",
            Self::PermissionAsk { .. } => "permission_ask",
            Self::ContextThreshold { .. } => "context_threshold",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SenderClass {
    System,
    Agent,
}

fn escape_attr(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const RESERVED: [&str; 4] = ["agent_message", "system_message", "msg", "reply_to"];

/// A body can never close its wrapper or open a tag of ours: the `<` of
/// every reserved tag in it is written `&lt;`.
pub fn escape_tag_body(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let name = after.strip_prefix('/').unwrap_or(after);
        let reserved = RESERVED.iter().any(|tag| {
            name.strip_prefix(tag)
                .is_some_and(|tail| !tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
        });
        out.push_str(if reserved { "&lt;" } else { "<" });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `body` wrapped in the sender's tag, with the attributes that have a value.
pub fn apply_sender_tag(body: &str, class: SenderClass, attrs: &[(&str, Option<String>)]) -> String {
    let tag = if class == SenderClass::System { "system_message" } else { "agent_message" };
    let mut rendered = String::new();
    for (key, value) in attrs {
        if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
            rendered.push_str(&format!(" {key}=\"{}\"", escape_attr(value)));
        }
    }
    format!("<{tag}{rendered}>\n{}\n</{tag}>", escape_tag_body(body))
}

/// The tag an envelope's message is delivered in.
pub fn sender_tag(envelope: &Envelope) -> (SenderClass, Vec<(&'static str, Option<String>)>) {
    let some = |s: &str| Some(s.to_owned());
    match envelope {
        Envelope::OrchestratorMessage { from_parent, parent_name } => (
            SenderClass::Agent,
            vec![("from", parent_name.clone().or(some(from_parent))), ("from-id", some(from_parent))],
        ),
        Envelope::PeerRequest { from_worker, from_name } => (
            SenderClass::Agent,
            vec![("from", from_name.clone().or(some(from_worker))), ("from-id", some(from_worker))],
        ),
        Envelope::WorkerReport { provenance, from_worker, worker_name, branch, worktree_dir, status } => {
            let who = [
                ("from", worker_name.clone().or(some(from_worker))),
                ("worker-id", some(from_worker)),
                ("branch", branch.clone()),
                ("worktree", worktree_dir.clone()),
            ];
            if provenance.as_deref() == Some("system") {
                let mut attrs = vec![("kind", some("worker_report"))];
                attrs.extend(who);
                attrs.push(("status", status.clone()));
                (SenderClass::System, attrs)
            } else {
                (SenderClass::Agent, who.to_vec())
            }
        }
        Envelope::Loop { attempt } => {
            (SenderClass::System, vec![("kind", some("dynamic_loop")), ("attempt", attempt.map(|a| a.to_string()))])
        }
        Envelope::ReportReminder => (SenderClass::System, vec![("kind", some("report_reminder"))]),
        Envelope::PermissionAsk { pending_id, from_worker, worker_name, tool_name, input_summary, expires_at } => (
            SenderClass::System,
            vec![
                ("kind", some("permission_ask")),
                ("from", worker_name.clone().or(some(from_worker))),
                ("worker-id", some(from_worker)),
                ("tool", some(tool_name)),
                ("summary", input_summary.clone()),
                ("pending-id", some(pending_id)),
                ("expires-at", expires_at.map(|t| t.to_string())),
            ],
        ),
        Envelope::ContextThreshold { stage, from_worker, worker_name, pct } => (
            SenderClass::System,
            vec![
                ("kind", some("context_threshold")),
                ("stage", some(stage)),
                ("from", worker_name.clone().or(some(from_worker))),
                ("worker-id", some(from_worker)),
                ("pct", pct.map(|p| eos_contracts::primitives::Num(p).to_string())),
            ],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::strip_sender_tags;

    // core/src/__tests__/sender-tag.test.ts
    #[test]
    fn a_message_is_wrapped_in_its_senders_tag() {
        let from_parent =
            Envelope::OrchestratorMessage { from_parent: "o-1".into(), parent_name: Some("Lead \"A\"".into()) };
        let (class, mut attrs) = sender_tag(&from_parent);
        attrs.push(("id", Some("7".into())));
        let wrapped = apply_sender_tag("do </agent_message> this <b>now</b>", class, &attrs);
        assert_eq!(
            wrapped,
            "<agent_message from=\"Lead &quot;A&quot;\" from-id=\"o-1\" id=\"7\">\ndo &lt;/agent_message> this <b>now</b>\n</agent_message>"
        );
        assert_eq!(strip_sender_tags(&wrapped), "do </agent_message> this <b>now</b>", "what the chat shows");

        let report = Envelope::WorkerReport {
            provenance: Some("system".into()),
            from_worker: "w-1".into(),
            worker_name: None,
            branch: Some("eos-x".into()),
            worktree_dir: None,
            status: Some("DONE".into()),
        };
        let (class, attrs) = sender_tag(&report);
        assert_eq!(
            apply_sender_tag("ended", class, &attrs),
            "<system_message kind=\"worker_report\" from=\"w-1\" worker-id=\"w-1\" branch=\"eos-x\" status=\"DONE\">\nended\n</system_message>"
        );
        let (class, attrs) = sender_tag(&Envelope::Loop { attempt: Some(3) });
        assert_eq!(
            apply_sender_tag("go on", class, &attrs),
            "<system_message kind=\"dynamic_loop\" attempt=\"3\">\ngo on\n</system_message>"
        );
    }

    #[test]
    fn an_envelope_keeps_its_stored_shape() {
        let stored = r#"{"kind":"worker_report","fromWorker":"w-1","workerName":"impl","branch":"eos-x"}"#;
        let envelope: Envelope = serde_json::from_str(stored).expect("reads");
        assert_eq!(envelope.kind(), "worker_report");
        assert_eq!(serde_json::to_string(&envelope).expect("writes"), stored);
        assert_eq!(serde_json::to_string(&Envelope::ReportReminder).expect("writes"), r#"{"kind":"report_reminder"}"#);
    }
}
