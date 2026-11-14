//! Telling people about an ask: the banner for the user and the one-line
//! summary of what the tool was called with.

use eos_domain::{PendingPermission, Worker};
use serde::Serialize;
use serde_json::Value;

/// The payload of `notification:fire`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub title: String,
    pub body: String,
    pub worker_id: String,
    pub ts: i64,
}

/// Cuts `text` to `max` UTF-16 code units, the last one an ellipsis.
pub fn truncate(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    let mut cut = String::from_utf16_lossy(&units[..max.saturating_sub(1)]);
    cut.push('…');
    cut
}

/// What JavaScript's `\s` matches.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// One line, at most 160 units: runs of whitespace become a space.
fn clean(text: &str) -> String {
    let mut line = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            in_space = true;
        } else {
            if in_space && !line.is_empty() {
                line.push(' ');
            }
            in_space = false;
            line.push(c);
        }
    }
    truncate(&line, 160)
}

/// A pending row's input (JSON text) as one short line: the command, else
/// the file path, else the input itself.
pub fn summarize_pending_input(input: &str) -> String {
    let non_blank = |v: &Value| v.as_str().filter(|s| s.chars().any(|c| !is_js_space(c))).map(clean);
    match serde_json::from_str::<Value>(input) {
        Ok(Value::Object(record)) => record
            .get("command")
            .and_then(non_blank)
            .or_else(|| record.get("file_path").and_then(non_blank))
            .unwrap_or_else(|| clean(input)),
        _ => clean(input),
    }
}

/// The banner for an ask: "<name> wants to run <tool>: <summary>". `input` is
/// the call's input as JSON text; `worker_name` falls back to the worker's id.
pub fn approval_notification(
    worker_id: &str,
    tool_name: &str,
    input: &str,
    worker_name: Option<&str>,
    now: i64,
) -> Notification {
    let name = worker_name.unwrap_or(worker_id);
    let summary = summarize_pending_input(input);
    let detail = if summary.is_empty() { String::new() } else { format!(": {summary}") };
    Notification {
        title: "Approval needed".to_owned(),
        body: format!("{name} wants to run {tool_name}{detail}"),
        worker_id: worker_id.to_owned(),
        ts: now,
    }
}

/// What to tell the asking worker's parent: the session that can act on the
/// ask. Sent queued (never into a running turn), once per ask (`client_msg_id`),
/// with origin `permission-ask`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParentNudge {
    pub parent_id: String,
    pub text: String,
    /// The `permission_ask` message envelope.
    pub envelope: Value,
    pub client_msg_id: String,
}

/// The nudge for an ask of `asker`; `None` for a top-level worker. The
/// caller checks that the parent still exists.
pub fn parent_nudge(ask: &PendingPermission, asker: &Worker) -> Option<ParentNudge> {
    let parent_id = asker.parent_id.clone().filter(|id| !id.is_empty())?;
    let name = asker.name.as_deref().filter(|name| !name.is_empty());
    let summary = summarize_pending_input(&ask.input);
    let detail = if summary.is_empty() { String::new() } else { format!(": {summary}") };
    let text = format!(
        "Worker {} ({}) is blocked waiting for permission to run {}{detail}. It cannot proceed until the ask is \
         approved in the dashboard or cleared by a policy rule. Before surfacing it to the operator, confirm it is \
         still pending with list_pending_permissions — by the time you read this the ask may already have been \
         resolved or expired, and no further signal is sent when it clears.",
        name.unwrap_or(&ask.worker_id),
        ask.worker_id,
        ask.tool_name,
    );
    let mut envelope = serde_json::Map::new();
    envelope.insert("kind".into(), "permission_ask".into());
    envelope.insert("pendingId".into(), ask.id.clone().into());
    envelope.insert("fromWorker".into(), ask.worker_id.clone().into());
    if let Some(name) = name {
        envelope.insert("workerName".into(), name.into());
    }
    envelope.insert("toolName".into(), ask.tool_name.clone().into());
    if !summary.is_empty() {
        envelope.insert("inputSummary".into(), summary.into());
    }
    envelope.insert("expiresAt".into(), ask.expires_at.into());
    Some(ParentNudge {
        parent_id,
        text,
        envelope: Value::Object(envelope),
        client_msg_id: format!("perm-ask:{}", ask.id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_prefers_the_command_then_the_path() {
        assert_eq!(summarize_pending_input(r#"{"command":"  npm   run\n build ","file_path":"/x"}"#), "npm run build");
        assert_eq!(summarize_pending_input(r#"{"command":"  ","file_path":"/a/b.md"}"#), "/a/b.md");
        assert_eq!(summarize_pending_input(r#"{"url":"https://x"}"#), r#"{"url":"https://x"}"#);
        assert_eq!(summarize_pending_input("not json"), "not json");
        let long = summarize_pending_input(&format!(r#"{{"command":"{}"}}"#, "a".repeat(400)));
        assert_eq!(long.chars().count(), 160);
        assert!(long.ends_with('…'));
    }

    fn ask() -> PendingPermission {
        PendingPermission {
            id: "p-1".into(),
            worker_id: "w-child".into(),
            tool_name: "Bash".into(),
            input: r#"{"command":"git push origin main"}"#.into(),
            tool_use_id: None,
            created_at: 1,
            expires_at: 999,
            resolved: false,
            decision: None,
            reason: None,
            updated_input: None,
        }
    }

    #[test]
    fn the_banner_names_the_worker_and_the_tool() {
        let banner = approval_notification("w-1", "Edit", r#"{"file_path":"/repo/README.md"}"#, Some("Long chat"), 5);
        assert_eq!(
            serde_json::to_string(&banner).expect("json"),
            r#"{"title":"Approval needed","body":"Long chat wants to run Edit: /repo/README.md","workerId":"w-1","ts":5}"#
        );
        assert_eq!(approval_notification("w-1", "Edit", "", None, 5).body, "w-1 wants to run Edit");
    }

    #[test]
    fn the_parent_is_nudged_with_a_permission_ask_envelope() {
        let seeded = eos_testkit::TempStore::seeded("/s");
        let mut asker = seeded.store.read_blocking(|tx| tx.workers().find("w-KID1")).expect("reads").expect("a worker");
        asker.name = Some("Alice".into());
        asker.parent_id = Some("w-parent".into());
        let nudge = parent_nudge(&ask(), &asker).expect("has a parent");
        assert_eq!((nudge.parent_id.as_str(), nudge.client_msg_id.as_str()), ("w-parent", "perm-ask:p-1"));
        assert_eq!(
            serde_json::to_string(&nudge.envelope).expect("json"),
            r#"{"kind":"permission_ask","pendingId":"p-1","fromWorker":"w-child","workerName":"Alice","toolName":"Bash","inputSummary":"git push origin main","expiresAt":999}"#
        );
        assert!(nudge.text.starts_with(
            "Worker Alice (w-child) is blocked waiting for permission to run Bash: git push origin main. It cannot"
        ));
        assert!(nudge.text.contains("list_pending_permissions"));

        asker.parent_id = None;
        assert_eq!(parent_nudge(&ask(), &asker), None, "a top-level worker has nobody to nudge");
    }
}
