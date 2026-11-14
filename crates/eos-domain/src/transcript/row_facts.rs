//! What the conversation-wide lists read of one row, taken once when the row
//! is indexed and kept beside the log: the subagent selection's facts, and
//! the row as the dashboard's parser expands it (`normalizeEvents` in
//! `app/ui/src/lib/messageParser.js`) without the bodies no list shows: tool
//! inputs and outputs, reports, texts. Only what decides a list survives — a
//! description cut as the parser cuts it, whether a result was an error, the
//! artifact link a result names.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{CallRef, PROMPT_KINDS, call_refs, is, is_barrier, is_subagent_lifecycle};
use crate::display::sanitize_payload;

/// The facts of one row. A row none of the lists can ever use has none.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RowFacts {
    /// The calls the row is about (the subagent selection).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) refs: Vec<CallRef>,
    /// A prompt, a subagent's lifecycle or a turn barrier: always selected.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) always: bool,
    /// The call a `subagent_started` row names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) started: Option<String>,
    /// A prompt or a marker that hides prompts (clear, rewind, recall).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) prompt: Option<Prompt>,
    /// The row as the parser expands it, in its order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) items: Vec<Item>,
}

/// A row the clear / rewind / recall passes read (`applyClears`,
/// `applyRewinds`, `applyRecalls`). Texts are whitespace-collapsed as the
/// rewind match compares them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub(super) enum Prompt {
    #[serde(rename_all = "camelCase")]
    User {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        client_msg_ids: Vec<String>,
    },
    Orchestrator {
        text: String,
    },
    Cleared,
    Rewound {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Recalled {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        row_id: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_msg_id: Option<String>,
    },
}

/// One event of the parser's expanded stream. Ids are the call ids as
/// written; an empty or missing one is `None` wherever the parser tests it
/// for truth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub(super) enum Item {
    /// A tool call (`jsonl` `tool_use`).
    #[serde(rename_all = "camelCase")]
    Use {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        spawns: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<AgentInput>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact: Option<ArtifactInput>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ts_transcript: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_model: Option<String>,
    },
    /// A tool's result (`jsonl` `tool_result`).
    #[serde(rename_all = "camelCase")]
    Result {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ts_transcript: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_url: Option<String>,
    },
    /// A tool starting (`tool_running`).
    Running {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<AgentInput>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact: Option<ArtifactInput>,
    },
    /// A tool finishing (`tool_done`); `result` = it reported some output.
    #[serde(rename_all = "camelCase")]
    Done {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        result: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_url: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Started {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resumes: Option<String>,
    },
    /// `callId` as written (an empty one is not looked up by agent).
    #[serde(rename_all = "camelCase")]
    Completed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
    },
    #[serde(rename_all = "camelCase")]
    Profile {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
    /// Closes the plain tools that started before it.
    Turn,
    /// Closes everything that started before it.
    Exit,
}

/// What a call's input says about the subagent it may start: the parser's
/// description (`description || summary || prompt.slice(0, 100) || "agent"`),
/// its model and type. `None` everywhere is the parser's default.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) subagent_type: Option<String>,
}

/// What an `Artifact` call's input says about the page it names
/// (`artifactFromTool` in `app/ui/src/lib/artifactLink.js`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) action: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) asset: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    /// The page file's name, when the input names an html or markdown file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) page_name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) root: bool,
}

impl RowFacts {
    /// The facts of a stored row (`kind`, payload as JSON text), read as the
    /// dashboard reads the row: after the sender wrappers come off. `None`
    /// when no list can ever use the row.
    pub fn of(kind: &str, payload: Option<&str>) -> Option<Self> {
        let p = match payload {
            Some(text) => {
                let clean = sanitize_payload(text);
                serde_json::from_str::<Value>(clean.as_deref().unwrap_or(text)).unwrap_or(Value::Null)
            }
            None => Value::Null,
        };
        let refs = call_refs(kind, &p);
        let always = PROMPT_KINDS.contains(&kind) || is_subagent_lifecycle(kind, &p) || is_barrier(kind, &p);
        if refs.is_empty() && !always {
            return None;
        }
        let started =
            (kind == "agent_event" && is(&p, "type", "subagent_started")).then(|| non_empty(&p, "callId")).flatten();
        Some(Self { refs, always, started, prompt: prompt_of(kind, &p), items: items_of(kind, &p) })
    }

    pub fn to_json(&self) -> String {
        // Plain data: writing it as JSON cannot fail.
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Facts as [`to_json`](Self::to_json) wrote them; `None` when the text
    /// is not that.
    pub fn from_json(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

/// A string field, as the parser reads one.
fn string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// A string field that is not empty: the parser tests it for truth.
fn non_empty(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// JavaScript's truth of a field.
fn truthy(v: &Value, key: &str) -> bool {
    match v.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A number field, as `typeof x === "number"` sees it.
fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// `(s ?? "").replace(/\s+/g, " ").trim()`: the rewind match's view of a text.
fn collapse_whitespace(text: &str) -> String {
    text.split(is_js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// JavaScript's `\s`.
fn is_js_space(c: char) -> bool {
    matches!(c, '\u{feff}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}')
        || matches!(c, '\u{205f}' | '\u{3000}' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ')
}

/// The first `max` UTF-16 units of `text`, as `slice(0, max)` takes them; a
/// pair the cut would split is left out whole.
pub(super) fn utf16_prefix(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &text[..at];
        }
    }
    text
}

fn prompt_of(kind: &str, p: &Value) -> Option<Prompt> {
    let text = |key| collapse_whitespace(p.get(key).and_then(Value::as_str).unwrap_or_default());
    match kind {
        "user_message" => Some(Prompt::User {
            text: text("text"),
            client_msg_ids: p
                .get("clientMsgIds")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default(),
        }),
        "orchestrator_message" => Some(Prompt::Orchestrator { text: text("text") }),
        "conversation_cleared" => Some(Prompt::Cleared),
        "conversation_rewound" => Some(Prompt::Rewound {
            text: Some(text("text")).filter(|t| !t.is_empty()),
            display: Some(text("display")).filter(|t| !t.is_empty()),
            index: number(p, "index"),
        }),
        "message_recalled" => {
            Some(Prompt::Recalled { row_id: number(p, "recalledRowId"), client_msg_id: non_empty(p, "clientMsgId") })
        }
        _ => None,
    }
}

/// `normalizeEvents` for one row, keeping only what the lists read.
fn items_of(kind: &str, p: &Value) -> Vec<Item> {
    match kind {
        "agent_event" => agent_event_items(p),
        "jsonl" if is(p, "kind", "tool_use") => vec![Item::Use {
            id: non_empty(p, "id"),
            name: string(p, "name"),
            spawns: p.get("spawnsSubagent") == Some(&Value::Bool(true)),
            agent: agent_input(p.get("input")),
            artifact: artifact_input(string(p, "name").as_deref(), p.get("input")),
            ts_transcript: number(p, "tsTranscript"),
            parent_model: string(p, "parentModel"),
        }],
        "jsonl" if is(p, "kind", "tool_result") => vec![Item::Result {
            id: non_empty(p, "toolUseId"),
            is_error: p.get("isError") == Some(&Value::Bool(true)),
            ts_transcript: number(p, "tsTranscript"),
            artifact_url: p.get("text").and_then(Value::as_str).and_then(artifact_url),
        }],
        "tool_running" => vec![running(p, "toolUseId", "parentAgentToolUseId")],
        "tool_done" => vec![Item::Done {
            id: non_empty(p, "toolUseId"),
            is_error: p.get("isError") == Some(&Value::Bool(true)),
            result: has_output(p.get("result")),
            artifact_url: p.get("result").and_then(Value::as_str).and_then(artifact_url),
        }],
        "hook" if is(p, "event", "Stop") || is(p, "event", "SessionEnd") => vec![Item::Turn],
        "state" if ["IDLE", "ENDING", "DONE"].iter().any(|s| is(p, "state", s)) => vec![Item::Turn],
        "lifecycle" if is(p, "phase", "interrupted") || is(p, "phase", "delivery_failed") => vec![Item::Turn],
        "lifecycle" if is(p, "phase", "pty_exit") => vec![Item::Exit],
        "exit" => vec![Item::Exit],
        _ => Vec::new(),
    }
}

fn agent_event_items(e: &Value) -> Vec<Item> {
    let blocks = || e.get("blocks").and_then(Value::as_array).into_iter().flatten();
    match e.get("type").and_then(Value::as_str) {
        Some("message") if is(e, "role", "assistant") => blocks()
            .filter_map(|b| {
                if is(b, "type", "tool_call") {
                    let name = string(b, "name");
                    Some(Item::Use {
                        id: non_empty(b, "callId"),
                        artifact: artifact_input(name.as_deref(), b.get("input")),
                        name,
                        spawns: truthy(b, "spawnsSubagent"),
                        agent: agent_input(b.get("input")),
                        ts_transcript: None,
                        parent_model: None,
                    })
                } else if is(b, "type", "tool_result") {
                    Some(block_result(b))
                } else {
                    None
                }
            })
            .collect(),
        Some("message") if is(e, "role", "tool") => {
            blocks().filter(|b| is(b, "type", "tool_result")).map(block_result).collect()
        }
        Some("activity") if is(e, "kind", "tool_started") => vec![running(e, "callId", "parentCallId")],
        Some("activity") if is(e, "kind", "tool_finished") => vec![Item::Done {
            id: non_empty(e, "callId"),
            is_error: truthy(e, "isError"),
            result: has_output(e.get("result")),
            artifact_url: e.get("result").and_then(Value::as_str).and_then(artifact_url),
        }],
        Some("turn") if !is(e, "phase", "started") => vec![Item::Turn],
        Some("session") if is(e, "phase", "ended") => vec![Item::Exit],
        Some("subagent_started") => vec![Item::Started {
            call_id: non_empty(e, "callId"),
            agent_id: string(e, "agentId"),
            resumes: string(e, "resumes"),
        }],
        Some("subagent_completed") => vec![Item::Completed {
            call_id: string(e, "callId"),
            agent_id: string(e, "agentId"),
            status: string(e, "status"),
            usage: e.get("usage").filter(|u| !u.is_null()).cloned(),
        }],
        Some("subagent_profile") => vec![Item::Profile {
            call_id: non_empty(e, "callId"),
            model: string(e, "model"),
            effort: string(e, "effort"),
        }],
        _ => Vec::new(),
    }
}

fn block_result(b: &Value) -> Item {
    Item::Result {
        id: non_empty(b, "callId"),
        is_error: truthy(b, "isError"),
        ts_transcript: None,
        artifact_url: b.get("content").and_then(Value::as_str).and_then(artifact_url),
    }
}

fn running(p: &Value, id_key: &str, parent_key: &str) -> Item {
    let name = string(p, "toolName");
    let parent = non_empty(p, parent_key);
    // A tool started under a subagent is one of its tools, never a subagent
    // or a page of the transcript's own: its input is read only on demand.
    let (agent, artifact) = if parent.is_some() {
        (None, artifact_input(name.as_deref(), p.get("input")))
    } else {
        (agent_input(p.get("input")), artifact_input(name.as_deref(), p.get("input")))
    };
    Item::Running { id: non_empty(p, id_key), name, parent, agent, artifact }
}

/// `(result ?? "") !== ""`.
fn has_output(result: Option<&Value>) -> bool {
    match result {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn agent_input(input: Option<&Value>) -> Option<AgentInput> {
    let input = input.filter(|i| i.is_object())?;
    let text = |key| non_empty(input, key);
    let prompt = match input.get("prompt") {
        None | Some(Value::Null) => input.get("message").and_then(Value::as_str).unwrap_or_default(),
        Some(prompt) => prompt.as_str().unwrap_or_default(),
    };
    let description = text("description")
        .or_else(|| text("summary"))
        .or_else(|| Some(utf16_prefix(prompt, 100).to_owned()).filter(|d| !d.is_empty()));
    let agent =
        AgentInput { description, model: string(input, "model"), subagent_type: string(input, "subagent_type") };
    (agent != AgentInput::default()).then_some(agent)
}

fn artifact_input(name: Option<&str>, input: Option<&Value>) -> Option<ArtifactInput> {
    if name != Some("Artifact") {
        return None;
    }
    let empty = Value::Object(serde_json::Map::new());
    let input = input.filter(|i| !i.is_null()).unwrap_or(&empty);
    Some(ArtifactInput {
        action: string(input, "action"),
        asset: truthy(input, "asset"),
        url: string(input, "url"),
        title: string(input, "title"),
        page_name: input.get("file_path").and_then(Value::as_str).and_then(page_name),
        root: truthy(input, "root"),
    })
}

/// `/([^/]+)\.(?:html?|md)$/i` on a page file's path: its name.
fn page_name(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    let ext = [".html", ".htm", ".md"].into_iter().find(|ext| lower.ends_with(ext))?;
    let stem = &path[..path.len() - ext.len()];
    let name = stem.rsplit('/').next().unwrap_or(stem);
    (!name.is_empty()).then(|| name.to_owned())
}

/// The first claude.ai artifact link in a tool's output
/// (`ARTIFACT_URL` in `app/ui/src/lib/artifactLink.js`).
fn artifact_url(text: &str) -> Option<String> {
    let mut from = 0;
    while let Some(at) = text[from..].find("https://") {
        let start = from + at;
        let rest = &text[start + "https://".len()..];
        let rest = rest.strip_prefix("preview.").unwrap_or(rest);
        let host_end = rest
            .strip_prefix("claude.ai/")
            .or_else(|| rest.strip_prefix("claude.com/"))
            .map(|r| r.strip_prefix("code/").unwrap_or(r))
            .and_then(|r| r.strip_prefix("artifact/"));
        if let Some(id) = host_end {
            let len = id.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).unwrap_or(id.len());
            if len > 0 {
                let end = text.len() - id.len() + len;
                return Some(text[start..end].to_owned());
            }
        }
        from = start + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn facts(kind: &str, payload: Value) -> Option<RowFacts> {
        RowFacts::of(kind, Some(&payload.to_string()))
    }

    #[test]
    fn rows_no_list_can_use_have_no_facts() {
        assert_eq!(
            facts(
                "agent_event",
                json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": "hi"}]})
            ),
            None
        );
        assert_eq!(facts("state", json!({"state": "WORKING"})), None);
        assert_eq!(facts("policy", json!({"decision": "allow"})), None);
        assert!(facts("state", json!({"state": "IDLE"})).is_some_and(|f| f.always && f.items == [Item::Turn]));
    }

    #[test]
    fn a_launch_keeps_its_description_cut_as_the_parser_cuts_it() {
        let prompt = "é".repeat(60) + &"😀".repeat(30);
        let f = facts(
            "agent_event",
            json!({"type": "message", "role": "assistant", "blocks": [
                {"type": "tool_call", "callId": "c1", "name": "Agent", "spawnsSubagent": true,
                 "input": {"prompt": prompt, "subagent_type": "Explore", "model": "haiku"}}
            ]}),
        )
        .expect("facts");
        let Item::Use { agent: Some(agent), spawns: true, .. } = &f.items[0] else { panic!("{:?}", f.items) };
        // 60 units of é, then 20 whole emoji (two units each).
        assert_eq!(agent.description.as_deref(), Some(&*("é".repeat(60) + &"😀".repeat(20))));
        assert_eq!(agent.subagent_type.as_deref(), Some("Explore"));
        assert_eq!(agent.model.as_deref(), Some("haiku"));
    }

    #[test]
    fn a_description_falls_back_from_description_to_summary_to_prompt_to_none() {
        let input = |v: Value| agent_input(Some(&v)).and_then(|a| a.description);
        assert_eq!(input(json!({"description": "d", "summary": "s", "prompt": "p"})).as_deref(), Some("d"));
        assert_eq!(input(json!({"description": "", "summary": "s"})).as_deref(), Some("s"));
        assert_eq!(input(json!({"message": "resume me", "summary": ""})).as_deref(), Some("resume me"));
        assert_eq!(input(json!({"prompt": null, "message": "m"})).as_deref(), Some("m"));
        assert_eq!(input(json!({"prompt": "", "message": "m"})), None, "an empty prompt wins over the message");
        assert_eq!(agent_input(Some(&json!({"command": "ls"}))), None);
    }

    #[test]
    fn an_artifact_call_keeps_what_names_its_page() {
        let f = facts(
            "agent_event",
            json!({"type": "message", "role": "assistant", "blocks": [
                {"type": "tool_call", "callId": "a1", "name": "Artifact", "input": {"file_path": "/tmp/My Notes.HTML", "root": "", "asset": 0}}
            ]}),
        )
        .expect("facts");
        let Item::Use { artifact: Some(a), .. } = &f.items[0] else { panic!("{:?}", f.items) };
        assert_eq!(a.page_name.as_deref(), Some("My Notes"));
        assert!(!a.root && !a.asset);
        assert_eq!(page_name("x/.md"), None);
        assert_eq!(page_name("notes.markdown"), None);
    }

    #[test]
    fn a_result_keeps_only_the_artifact_link_it_names() {
        let url = "https://claude.ai/code/artifact/0b5e7a2c-1111-2222-3333-444455556666";
        assert_eq!(artifact_url(&format!("Published {url}/x and more")).as_deref(), Some(url));
        assert_eq!(artifact_url("https://claude.ai/artifact/").as_deref(), None);
        assert_eq!(
            artifact_url("see https://example.com then https://preview.claude.com/artifact/AbC-9?x").as_deref(),
            Some("https://preview.claude.com/artifact/AbC-9")
        );
        let f = facts(
            "agent_event",
            json!({"type": "activity", "kind": "tool_finished", "callId": "t", "result": {"a": 1}, "isError": 1}),
        )
        .expect("facts");
        assert_eq!(f.items, [Item::Done { id: Some("t".into()), is_error: true, result: true, artifact_url: None }]);
    }

    #[test]
    fn prompts_and_markers_are_read_for_the_rewind_and_recall_passes() {
        let f = facts("user_message", json!({"text": "  two\n\nwords ", "clientMsgIds": ["c1", 2]})).expect("facts");
        assert_eq!(f.prompt, Some(Prompt::User { text: "two words".into(), client_msg_ids: vec!["c1".into()] }));
        let f = facts("conversation_rewound", json!({"text": " ", "index": 2})).expect("facts");
        assert_eq!(f.prompt, Some(Prompt::Rewound { text: None, display: None, index: Some(2.0) }));
        let f = facts("user_message", json!({"text": "<msg id=\"m-1\"/>\nHello"})).expect("facts");
        assert_eq!(
            f.prompt,
            Some(Prompt::User { text: "Hello".into(), client_msg_ids: vec![] }),
            "read without its wrapper"
        );
    }

    #[test]
    fn facts_round_trip_through_their_json() {
        let f = facts(
            "agent_event",
            json!({"type": "subagent_completed", "callId": "", "agentId": "a", "status": "failed", "usage": {"durationMs": 5}}),
        )
        .expect("facts");
        assert_eq!(RowFacts::from_json(&f.to_json()), Some(f));
    }
}
