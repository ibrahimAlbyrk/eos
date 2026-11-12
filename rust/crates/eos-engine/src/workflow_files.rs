//! What the engine keeps about workflow runs
//! ([`WorkflowRunFiles`](eos_core::agent::WorkflowRunFiles)).
//!
//! A run of a session writes, in Claude Code's layout under the engine's
//! `workflows/<session>/`: `workflows/<runId>.json` (its record, at the end)
//! and `subagents/workflows/<runId>/` (its journal). Its agents are
//! subagents: their conversations are in the engine's transcript store, by
//! agent id.
//!
//! Runs from before the engine are Claude Code's own, under its projects
//! folder, with each agent's transcript beside the journal
//! (`agent-<id>.jsonl`). Both are read; nothing else is.

use std::path::{Path, PathBuf};

use eos_agent_core::StoredMessage;
use eos_agent_engine::JsonlStore;
use eos_agent_types::{ContentBlock, Role};
use eos_contracts::PtyConversationRow;
use eos_core::BoxFuture;
use eos_core::agent::WorkflowRunFiles;
use eos_domain::claude_transcript::transcript_view;
use eos_domain::workflow_run::{workflow_agent_transcript_path, workflow_record_path};
use serde_json::{Map, Value, json};

use crate::engine::EngineOptions;
use crate::transcript::{is_noise, result_text};

/// The engine's subagent tool: a call of it starts a subagent on every lane.
const SUBAGENT_TOOL: &str = "Agent";

#[derive(Debug, Clone)]
pub struct WorkflowFiles {
    /// The engine's run folders.
    runs: PathBuf,
    /// Claude Code's projects folder: the runs of chats from before the engine.
    claude_projects: Option<PathBuf>,
    transcripts: JsonlStore,
}

fn row(id: usize, ts: Option<u64>, kind: &str, payload: Value) -> PtyConversationRow {
    let ts = ts.map_or(0.0, |ms| ms as f64);
    PtyConversationRow { id: id as i64, ts: ts.into(), r#type: kind.to_owned(), payload: Some(payload) }
}

/// An assistant message's blocks as a session's own events carry them.
fn assistant_blocks(id: usize, blocks: Vec<ContentBlock>) -> Vec<Value> {
    let mut out = Vec::new();
    for (i, block) in blocks.into_iter().enumerate() {
        let block_id = format!("m{id}:{i}");
        match block {
            ContentBlock::Text { text, .. } => out.push(json!({"type": "text", "text": text, "blockId": block_id})),
            ContentBlock::Thinking { thinking, .. } if !thinking.trim().is_empty() => {
                out.push(json!({"type": "reasoning", "text": thinking, "blockId": block_id}));
            }
            ContentBlock::ToolUse { id, name, input } => {
                let mut call = Map::new();
                call.insert("type".into(), json!("tool_call"));
                call.insert("callId".into(), json!(id));
                let spawns = name == SUBAGENT_TOOL;
                call.insert("name".into(), json!(name));
                call.insert("input".into(), serde_json::from_str(input.get()).unwrap_or_else(|_| json!({})));
                if spawns {
                    call.insert("spawnsSubagent".into(), json!(true));
                }
                out.push(Value::Object(call));
            }
            _ => {}
        }
    }
    out
}

/// A recorded conversation as worker-event rows. A row's id is its
/// message's position, so it stays the same while the conversation grows.
pub(crate) fn rows(messages: &[StoredMessage]) -> Vec<PtyConversationRow> {
    let mut out = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let (id, ts) = (index + 1, message.recorded_ms());
        let Ok(blocks) = message.blocks() else { continue };
        match message.role() {
            Role::Assistant => {
                let blocks = assistant_blocks(id, blocks);
                if !blocks.is_empty() {
                    out.push(row(
                        id,
                        ts,
                        "agent_event",
                        json!({"type": "message", "role": "assistant", "blocks": blocks}),
                    ));
                }
            }
            Role::User => {
                let results: Vec<Value> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolResult { tool_use_id, content, is_error } => Some(json!({
                            "type": "tool_result",
                            "callId": tool_use_id,
                            "isError": is_error,
                            "content": result_text(content.as_ref()),
                        })),
                        _ => None,
                    })
                    .collect();
                if !results.is_empty() {
                    out.push(row(id, ts, "agent_event", json!({"type": "message", "role": "tool", "blocks": results})));
                    continue;
                }
                let said: Vec<&str> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text, .. } if !text.trim().is_empty() && !is_noise(text) => {
                            Some(text.as_str())
                        }
                        _ => None,
                    })
                    .collect();
                if !said.is_empty() {
                    out.push(row(id, ts, "user_message", json!({"text": said.join("\n")})));
                }
            }
            Role::System => {}
        }
    }
    out
}

impl WorkflowFiles {
    /// `claude_projects`: Claude Code's projects folder, for the runs it recorded.
    pub fn new(options: &EngineOptions, claude_projects: Option<PathBuf>) -> Self {
        Self {
            runs: options.dir.join("workflows"),
            claude_projects,
            transcripts: JsonlStore::new(options.dir.join("transcripts")),
        }
    }

    fn within(root: &Path, dir: &str) -> bool {
        let dir = Path::new(dir);
        dir != root && dir.starts_with(root)
    }

    fn is_own(&self, dir: &str) -> bool {
        Self::within(&self.runs, dir)
    }

    fn is_claudes(&self, dir: &str) -> bool {
        self.claude_projects.as_deref().is_some_and(|root| Self::within(root, dir))
    }
}

impl WorkflowRunFiles for WorkflowFiles {
    fn record<'a>(&'a self, transcript_dir: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let path = workflow_record_path(transcript_dir)?;
            if !self.is_own(transcript_dir) && !self.is_claudes(transcript_dir) {
                return None;
            }
            tokio::fs::read_to_string(path).await.ok()
        })
    }

    fn agent_rows<'a>(
        &'a self,
        transcript_dir: &'a str,
        agent_id: &'a str,
    ) -> BoxFuture<'a, Option<Vec<PtyConversationRow>>> {
        Box::pin(async move {
            let legacy = workflow_agent_transcript_path(transcript_dir, agent_id)?;
            if self.is_own(transcript_dir) {
                let messages = self.transcripts.load(agent_id).await.ok()?;
                return (!messages.is_empty()).then(|| rows(&messages));
            }
            if self.is_claudes(transcript_dir) {
                let jsonl = tokio::fs::read_to_string(legacy).await.ok()?;
                return Some(transcript_view(&jsonl, true).rows);
            }
            None
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::value::RawValue;

    fn message(role: Role, blocks: &[ContentBlock]) -> StoredMessage {
        StoredMessage::new(role, blocks).expect("a message").with_recorded_ms(Some(7))
    }

    fn text(text: &str) -> ContentBlock {
        ContentBlock::Text { text: text.into(), citations: None }
    }

    #[test]
    fn a_recorded_conversation_reads_as_worker_event_rows() {
        let input = RawValue::from_string(r#"{"file_path":"a.rs"}"#.into()).expect("json");
        let conversation = [
            message(Role::User, &[text("look at a.rs")]),
            message(
                Role::Assistant,
                &[
                    ContentBlock::Thinking { thinking: "hm".into(), signature: String::new() },
                    text("Reading."),
                    ContentBlock::ToolUse { id: "t1".into(), name: "Read".into(), input },
                ],
            ),
            message(
                Role::User,
                &[ContentBlock::ToolResult { tool_use_id: "t1".into(), content: None, is_error: true }],
            ),
            message(Role::User, &[text("<system-reminder>noise</system-reminder>")]),
        ];
        let rows = rows(&conversation);
        let shapes: Vec<(i64, &str)> = rows.iter().map(|r| (r.id, r.r#type.as_str())).collect();
        assert_eq!(shapes, [(1, "user_message"), (2, "agent_event"), (3, "agent_event")]);
        assert_eq!(rows[0].payload, Some(json!({"text": "look at a.rs"})));
        assert_eq!(
            rows[1].payload,
            Some(json!({"type": "message", "role": "assistant", "blocks": [
                {"type": "reasoning", "text": "hm", "blockId": "m2:0"},
                {"type": "text", "text": "Reading.", "blockId": "m2:1"},
                {"type": "tool_call", "callId": "t1", "name": "Read", "input": {"file_path": "a.rs"}},
            ]}))
        );
        assert_eq!(
            rows[2].payload,
            Some(json!({"type": "message", "role": "tool", "blocks": [
                {"type": "tool_result", "callId": "t1", "isError": true, "content": ""},
            ]}))
        );
    }

    #[tokio::test]
    async fn only_run_folders_of_the_engine_or_of_claude_code_are_read() {
        let dir = tempfile::tempdir().expect("a folder");
        let home = dir.path().canonicalize().expect("the folder");
        let options = EngineOptions::new(home.join("engine"));
        let files = WorkflowFiles::new(&options, Some(home.join("claude/projects")));

        // The engine's own run: its record, and the agent's conversation from the transcript store.
        let own = home.join("engine/workflows/w-1/subagents/workflows/wf_1");
        std::fs::create_dir_all(home.join("engine/workflows/w-1/workflows")).expect("a folder");
        std::fs::write(home.join("engine/workflows/w-1/workflows/wf_1.json"), r#"{"logs":["done"]}"#).expect("writes");
        let store = JsonlStore::new(home.join("engine/transcripts"));
        let said = message(Role::User, &[text("go")]);
        eos_agent_core::TranscriptStore::append(&store, "a0123456789abcdef", &said, None).await.expect("appends");
        let own = own.to_string_lossy().into_owned();
        assert_eq!(files.record(&own).await.as_deref(), Some(r#"{"logs":["done"]}"#));
        let rows = files.agent_rows(&own, "a0123456789abcdef").await.expect("rows");
        assert_eq!(rows[0].payload, Some(json!({"text": "go"})));
        assert_eq!(files.agent_rows(&own, "anobody").await, None);

        // Claude Code's run: the agent's transcript lies beside the journal.
        let old = home.join("claude/projects/-p/sess/subagents/workflows/wf_2");
        std::fs::create_dir_all(&old).expect("a folder");
        let line = json!({"type": "user", "uuid": "u1", "parentUuid": null, "isSidechain": true,
                          "timestamp": "2026-01-01T00:00:00.000Z", "message": {"role": "user", "content": "old task"}});
        std::fs::write(old.join("agent-a1b2c3.jsonl"), line.to_string()).expect("writes");
        let old = old.to_string_lossy().into_owned();
        let rows = files.agent_rows(&old, "a1b2c3").await.expect("rows");
        assert_eq!(rows[0].payload, Some(json!({"text": "old task"})));
        assert_eq!(files.record(&old).await, None, "it wrote no record");

        // Anywhere else is nobody's run folder.
        let elsewhere = home.join("other/sess/subagents/workflows/wf_3");
        std::fs::create_dir_all(home.join("other/sess/workflows")).expect("a folder");
        std::fs::write(home.join("other/sess/workflows/wf_3.json"), "{}").expect("writes");
        let elsewhere = elsewhere.to_string_lossy().into_owned();
        assert_eq!(files.record(&elsewhere).await, None);
        assert_eq!(files.agent_rows(&elsewhere, "a1b2c3").await, None);
    }
}
