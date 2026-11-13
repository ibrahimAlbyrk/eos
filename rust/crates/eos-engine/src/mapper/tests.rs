//! The mapper against today's.
//!
//! `tests/vectors/*.json` hold conversations as the Claude Agent SDK streamed
//! them and what the TypeScript mapper made of each
//! (`tools/mapper-vectors`). [`Replay`] feeds the same conversation the way
//! this engine reports it; the events must be the same. What differs by
//! design is named in [`same_as_today`].

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use eos_agent_core::{
    AgentEvent as EngineEvent, BlockKind, ResponseUsage, TaskEvent, TaskEventKind, TaskUsage, ToolOutput,
};
use eos_agent_sdk::{SubagentEnded, SubagentEvent, SubagentEventKind, SubagentStarted};
use eos_agent_types::{ContentBlock, StopReason, Usage};
use eos_contracts::AgentEvent;
use eos_core::agent::{BackgroundTaskKind, BackgroundTaskUpdate, TaskOutcome};
use eos_testkit::RecordingSink;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::{Mapper, Side};

const WORKER: &str = "w-1";

fn raw(value: &Value) -> Arc<RawValue> {
    Arc::from(RawValue::from_string(value.to_string()).expect("json"))
}

fn s(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

/// Drives a mapper and keeps what it emitted.
struct Run {
    mapper: Mapper,
    sink: RecordingSink,
    now_ms: i64,
    out: Vec<AgentEvent>,
}

impl Run {
    fn new(follows: &[&str]) -> Self {
        let sink = RecordingSink::default();
        sink.follows.lock().expect("follows").extend(follows.iter().map(|f| (*f).to_owned()));
        Self { mapper: Mapper::new("L".into()), sink, now_ms: 0, out: Vec::new() }
    }

    fn agent(&mut self, event: EngineEvent) {
        let side = Side { sink: &self.sink, worker_id: WORKER, now_ms: self.now_ms };
        self.out.extend(self.mapper.agent(event, &side));
    }

    fn sub(&mut self, agent_id: &str, parent_id: &str, event: SubagentEventKind) {
        let side = Side { sink: &self.sink, worker_id: WORKER, now_ms: self.now_ms };
        let event = SubagentEvent { agent_id: agent_id.into(), parent_id: parent_id.into(), event };
        self.out.extend(self.mapper.subagent(event, &side));
    }

    fn task(&mut self, task_id: &str, call_id: &str, kind: TaskEventKind) {
        let side = Side { sink: &self.sink, worker_id: WORKER, now_ms: self.now_ms };
        let event =
            TaskEvent { agent_id: WORKER.into(), task_id: task_id.into(), tool_use_id: Some(call_id.into()), kind };
        self.out.extend(self.mapper.task(event, &side));
    }

    fn failed(&mut self, notice: Option<&str>) {
        let side = Side { sink: &self.sink, worker_id: WORKER, now_ms: self.now_ms };
        self.out.extend(self.mapper.turn_failed(notice, &side));
    }

    fn stop_live(&mut self) {
        let side = Side { sink: &self.sink, worker_id: WORKER, now_ms: self.now_ms };
        self.out.extend(self.mapper.stop_live(&side));
    }

    fn json(&self) -> Vec<Value> {
        self.out.iter().map(|e| serde_json::to_value(e).expect("an event serializes")).collect()
    }

    /// `type` (and phase or kind) of each event, for reading a sequence.
    fn tags(&self) -> Vec<String> {
        self.json().iter().map(tag).collect()
    }
}

fn tag(e: &Value) -> String {
    let kind = s(e, "type");
    match kind.as_str() {
        "turn" | "session" => format!("{kind}:{}", s(e, "phase")),
        "delta" => format!("delta:{}:{}", s(e, "channel"), s(e, "phase")),
        "message" => {
            let blocks: Vec<String> = e["blocks"].as_array().into_iter().flatten().map(|b| s(b, "type")).collect();
            format!("msg:{}:{}", s(e, "role"), blocks.join(","))
        }
        "activity" => format!("act:{}", s(e, "kind")),
        _ => kind,
    }
}

fn started(call: &str, model: &str, background: bool) -> SubagentEventKind {
    started_at(call, model, None, background)
}

fn started_at(call: &str, model: &str, effort: Option<&str>, background: bool) -> SubagentEventKind {
    SubagentEventKind::Started(Arc::new(SubagentStarted {
        tool_use_id: call.into(),
        agent_type: "general-purpose".into(),
        model: model.into(),
        effort: effort.map(str::to_owned),
        description: "look around".into(),
        name: None,
        background,
    }))
}

fn ended(status: &'static str, usage: Usage) -> SubagentEventKind {
    SubagentEventKind::Ended(Box::new(SubagentEnded { status, error: None, usage, tool_uses: 3, duration_ms: 1200 }))
}

fn tool_use(id: &str, name: &str, input: Value) -> EngineEvent {
    EngineEvent::ToolUse { id: id.into(), name: name.into(), input: raw(&input) }
}

fn tool_result(id: &str, text: &str) -> EngineEvent {
    EngineEvent::ToolResult { id: id.into(), output: Arc::new(ToolOutput::text(text)) }
}

fn usage(input: u64, output: u64, model: &str) -> EngineEvent {
    let usage = Usage { input_tokens: Some(input), output_tokens: Some(output), ..Usage::default() };
    EngineEvent::Usage(Box::new(ResponseUsage { usage, model: model.into() }))
}

fn turn_ended() -> EngineEvent {
    EngineEvent::TurnEnded { stop_reason: StopReason::EndTurn, stated: true }
}

// ---- the same conversations as the TypeScript mapper saw them -----------------

/// Feeds a Claude Agent SDK message stream as this engine would have
/// reported the same conversation.
struct Replay {
    run: Run,
    interrupt: bool,
    /// The message being streamed, and its blocks seen so far.
    message: Option<String>,
    opened: HashSet<u64>,
    closed: HashSet<u64>,
    tools: HashMap<u64, String>,
    /// How many blocks of each message arrived as finished messages.
    finished: HashMap<String, u64>,
    /// Foreground subagents by the call that started them.
    subs: HashSet<String>,
}

impl Replay {
    fn start(&mut self, index: u64, kind: BlockKind) {
        if self.opened.insert(index) {
            if let BlockKind::ToolUse { id, .. } = &kind {
                self.tools.insert(index, id.clone());
            }
            self.run.agent(EngineEvent::BlockStart { index: index as u32, block: kind });
        }
    }

    fn stop(&mut self, index: u64) {
        if self.closed.insert(index) {
            self.run.agent(EngineEvent::BlockStop { index: index as u32 });
        }
    }

    fn request(&mut self, id: &str) {
        if self.message.as_deref() != Some(id) {
            self.message = Some(id.to_owned());
            self.opened.clear();
            self.closed.clear();
            self.tools.clear();
            self.run.agent(EngineEvent::RequestStarted { attempt: 1 });
        }
    }

    fn block_kind(block: &Value) -> BlockKind {
        match block["type"].as_str() {
            Some("text") => BlockKind::Text,
            Some("thinking") => BlockKind::Thinking,
            Some("tool_use") => BlockKind::ToolUse { id: s(block, "id"), name: s(block, "name") },
            other => BlockKind::Other(other.unwrap_or_default().to_owned()),
        }
    }

    fn stream_event(&mut self, event: &Value) {
        let index = event["index"].as_u64().unwrap_or(0);
        match event["type"].as_str() {
            Some("message_start") => {
                self.message = None;
                self.request(&s(&event["message"], "id"));
            }
            Some("content_block_start") => self.start(index, Self::block_kind(&event["content_block"])),
            Some("content_block_stop") => self.stop(index),
            Some("content_block_delta") => {
                let delta = &event["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        self.start(index, BlockKind::Text);
                        self.run.agent(EngineEvent::TextDelta { text: s(delta, "text") });
                    }
                    Some("thinking_delta") => {
                        self.start(index, BlockKind::Thinking);
                        self.run.agent(EngineEvent::ThinkingDelta { text: s(delta, "thinking") });
                    }
                    Some("input_json_delta") => {
                        let id = self.tools.get(&index).cloned().unwrap_or_default();
                        self.run.agent(EngineEvent::ToolInputDelta { id, partial_json: s(delta, "partial_json") });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn sub_id(call: &str) -> String {
        format!("agent-{call}")
    }

    fn assistant(&mut self, msg: &Value) {
        let message = &msg["message"];
        let blocks = message["content"].as_array().cloned().unwrap_or_default();
        if let Some(parent) = msg["parent_tool_use_id"].as_str() {
            if self.subs.insert(parent.to_owned()) {
                self.run.sub(&Self::sub_id(parent), WORKER, started(parent, &s(message, "model"), false));
            }
            for block in blocks.iter().filter(|b| b["type"] == "tool_use") {
                let call = tool_use(&s(block, "id"), &s(block, "name"), block["input"].clone());
                self.run.sub(&Self::sub_id(parent), WORKER, SubagentEventKind::Agent(call));
            }
            return;
        }
        let id = s(message, "id");
        self.request(&id);
        for block in &blocks {
            let index = *self.finished.entry(id.clone()).and_modify(|n| *n += 1).or_insert(0);
            assert!(self.opened.contains(&index), "the scenario streams every block before its message");
            self.stop(index);
            if block["type"] == "tool_use" {
                self.run.agent(tool_use(&s(block, "id"), &s(block, "name"), block["input"].clone()));
            }
        }
        if let Some(used) = message.get("usage") {
            let usage: Usage = serde_json::from_value(used.clone()).expect("usage");
            self.run.agent(EngineEvent::Usage(Box::new(ResponseUsage { usage, model: String::new() })));
        }
    }

    fn user(&mut self, msg: &Value) {
        let results = msg["message"]["content"].as_array().cloned().unwrap_or_default();
        for result in results.iter().filter(|r| r["type"] == "tool_result") {
            let id = s(result, "tool_use_id");
            let mut output = match &result["content"] {
                Value::String(text) => ToolOutput::text(text.clone()),
                parts => {
                    let texts = parts.as_array().into_iter().flatten();
                    ToolOutput::blocks(
                        texts.map(|p| ContentBlock::Text { text: s(p, "text"), citations: None }).collect(),
                    )
                }
            };
            output.is_error = result["is_error"] == true;
            output.details = msg.get("tool_use_result").filter(|d| d.is_object()).map(raw);
            let event = EngineEvent::ToolResult { id: id.clone(), output: Arc::new(output) };
            match msg["parent_tool_use_id"].as_str() {
                Some(parent) => self.run.sub(&Self::sub_id(parent), WORKER, SubagentEventKind::Agent(event)),
                None => {
                    if self.subs.remove(&id) {
                        self.run.sub(&Self::sub_id(&id), WORKER, ended("completed", Usage::default()));
                    }
                    self.run.agent(event);
                }
            }
        }
    }

    fn task_usage(msg: &Value) -> TaskUsage {
        let n = |key: &str| msg["usage"][key].as_u64().unwrap_or(0);
        TaskUsage { total_tokens: n("total_tokens"), tool_uses: n("tool_uses"), duration_ms: n("duration_ms") }
    }

    fn system(&mut self, msg: &Value, all: &[Value]) {
        let (task, call) = (s(msg, "task_id"), s(msg, "tool_use_id"));
        match msg["subtype"].as_str() {
            Some("task_started") if msg["task_type"] == "local_workflow" => {
                // The engine's start event carries what Claude Code put in the launch result.
                let launch = all.iter().find(|m| m["tool_use_result"]["taskId"] == task.as_str());
                let launch = launch.map(|m| m["tool_use_result"].clone()).unwrap_or_default();
                let text = |key: &str| launch[key].as_str().map(str::to_owned);
                let kind = TaskEventKind::Started {
                    task_type: "local_workflow".into(),
                    description: text("summary").unwrap_or_default(),
                    workflow_name: text("workflowName").or(msg["workflow_name"].as_str().map(str::to_owned)),
                    run_id: text("runId"),
                    transcript_dir: text("transcriptDir"),
                    command: None,
                    output_file: None,
                };
                self.run.task(&task, &call, kind);
            }
            Some("task_progress") => {
                let kind = TaskEventKind::Progress {
                    description: String::new(),
                    usage: Self::task_usage(msg),
                    last_tool_name: None,
                    summary: None,
                    workflow_progress: msg.get("workflow_progress").map(raw),
                };
                self.run.task(&task, &call, kind);
            }
            Some("task_notification") => {
                let kind = TaskEventKind::Ended {
                    status: s(msg, "status"),
                    summary: s(msg, "summary"),
                    output_file: None,
                    usage: Self::task_usage(msg),
                    workflow_progress: None,
                    exit_code: None,
                };
                self.run.task(&task, &call, kind);
            }
            _ => {}
        }
    }

    fn result(&mut self, msg: &Value) {
        self.message = None;
        match msg["subtype"].as_str() {
            Some("error_max_turns") => {
                let stop_reason = StopReason::Other(eos_agent_core::MAX_TURNS.to_owned());
                self.run.agent(EngineEvent::TurnEnded { stop_reason, stated: true });
            }
            Some("error_during_execution") if self.interrupt => self.run.agent(EngineEvent::Interrupted),
            _ => self.run.agent(turn_ended()),
        }
    }

    fn play(vector: &Value) -> Run {
        let follows: Vec<&str> = vector["follows"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let mut replay = Replay {
            run: Run::new(&follows),
            interrupt: vector["interrupt"] == true,
            message: None,
            opened: HashSet::new(),
            closed: HashSet::new(),
            tools: HashMap::new(),
            finished: HashMap::new(),
            subs: HashSet::new(),
        };
        let messages = vector["messages"].as_array().expect("messages");
        for msg in messages {
            if let Some(at) = msg["_at"].as_i64() {
                replay.run.now_ms = at;
            }
            match msg["type"].as_str() {
                Some("stream_event") => replay.stream_event(&msg["event"]),
                Some("assistant") => replay.assistant(msg),
                Some("user") => replay.user(msg),
                Some("system") => replay.system(msg, messages),
                Some("result") => replay.result(msg),
                _ => {}
            }
        }
        replay.run
    }
}

/// Block ids differ by construction (today: the API's message id; here: the
/// launch and request number). What must hold is which events share one.
fn rename_block_ids(events: &mut [Value]) {
    let mut names: HashMap<String, String> = HashMap::new();
    let mut rename = |id: &mut Value| {
        if let Some(old) = id.as_str() {
            let next = format!("b{}", names.len());
            *id = Value::String(names.entry(old.to_owned()).or_insert(next).clone());
        }
    };
    for event in events {
        if let Some(id) = event.get_mut("blockId") {
            rename(id);
        }
        for block in event.get_mut("blocks").and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(id) = block.get_mut("blockId") {
                rename(id);
            }
        }
    }
}

/// What the TypeScript side recorded, in the terms both sides share.
fn todays(vector: &Value) -> Vec<Value> {
    let mut events: Vec<Value> = vector["expected"]["events"]
        .as_array()
        .expect("events")
        .iter()
        // The session's own events come from the session, not the mapper.
        .filter(|e| e["type"] != "session")
        .cloned()
        .collect();
    if vector["interrupt"] == true {
        // ClaudeSdkBackend reports the end of a turn it interrupted this way.
        for event in &mut events {
            if event["type"] == "turn" && event["reason"] == "error_during_execution" {
                *event = json!({"type": "turn", "phase": "aborted", "reason": "interrupted"});
            }
        }
    }
    rename_block_ids(&mut events);
    events
}

fn same_as_today(name: &str) -> (Value, Run) {
    let path = format!("{}/tests/vectors/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let vector: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("the vector")).expect("json");
    let run = Replay::play(&vector);
    let mut ours = run.json();
    let mut theirs = todays(&vector);
    if vector["recordsCutText"] == true {
        // By design: an answer cut off by an interrupt stays in the engine's
        // conversation, so it is recorded (today only a cut thought was).
        let cut = ours.iter().position(|e| e["type"] == "message").expect("the cut answer");
        let message = ours.remove(cut);
        assert_eq!(
            (message["blocks"][0]["type"].as_str(), message["blocks"][0]["text"].as_str()),
            (Some("text"), Some("partial answer"))
        );
    }
    rename_block_ids(&mut ours);
    for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
        assert_eq!(a, b, "{name}: event {i}");
    }
    assert_eq!(ours.len(), theirs.len(), "{name}: {:?}", run.tags());
    theirs.clear();
    (vector, run)
}

#[test]
fn text_and_thinking_stream_and_are_recorded_as_today() {
    let (_, run) = same_as_today("text-and-thinking");
    assert_eq!(
        run.tags(),
        [
            "turn:started",
            "delta:reasoning:start",
            "delta:reasoning:append",
            "delta:reasoning:stop",
            "msg:assistant:reasoning",
            "delta:text:start",
            "delta:text:append",
            "delta:text:stop",
            "msg:assistant:text",
            "context",
            "usage",
            "turn:ended"
        ]
    );
    assert_eq!(run.json()[4]["blocks"][0]["blockId"], "L-1:0", "a block is recorded under the id its deltas used");
}

#[test]
fn tools_usage_and_later_turns_are_recorded_as_today() {
    let (_, run) = same_as_today("tool-roundtrip");
    let ids: Vec<Value> = run.json().iter().filter(|e| e["phase"] == "start").map(|e| e["blockId"].clone()).collect();
    assert_eq!(ids, ["L-1:0", "L-2:0", "L-3:0"], "blocks of different requests never share an id");
    same_as_today("edit-patch");
    same_as_today("error-max-turns");
}

#[test]
fn an_interrupted_turn_records_what_was_streaming() {
    let (_, run) = same_as_today("interrupt-reasoning");
    let cut = run.json().into_iter().find(|e| e["blocks"][0]["interrupted"] == true).expect("the cut thought");
    assert_eq!(
        cut["blocks"],
        json!([{"type": "reasoning", "text": "half a thou", "blockId": "L-1:1", "interrupted": true}])
    );
    same_as_today("interrupt-text");
}

#[test]
fn a_subagents_tools_show_under_its_call_as_today() {
    same_as_today("subagent-foreground");
}

#[test]
fn a_followed_tools_input_is_paced_as_today() {
    let (vector, run) = same_as_today("followed-tool-input");
    let ours = serde_json::to_value(&*run.sink.tool_inputs.lock().expect("inputs")).expect("json");
    assert_eq!(ours, vector["expected"]["toolInput"]);
}

#[test]
fn a_workflow_run_starts_reports_and_ends_as_today() {
    let (vector, run) = same_as_today("workflow-run");
    let ours = run.sink.workflow.lock().expect("workflow");
    let theirs = vector["expected"]["workflow"].as_array().expect("progress");
    assert_eq!(ours.len(), theirs.len());
    for (a, b) in ours.iter().zip(theirs) {
        let a = serde_json::to_value(a).expect("json");
        for key in ["callId", "taskId", "snapshot", "usage"] {
            assert_eq!(a[key], b[key], "{key}");
        }
        assert_eq!((a["workerId"].as_str(), a["status"].as_str()), (Some(WORKER), Some("running")));
    }
    assert_eq!(serde_json::to_value(&ours[1]).expect("json")["updatedAt"], 6000);
}

// ---- what the engine reports with events of its own ---------------------------
// (today these came from launch stubs and notification text; the expected
// events are the TypeScript mapper's for the same situation)

#[test]
fn a_background_subagent_starts_after_its_launch_row_and_ends_with_its_reply() {
    let mut run = Run::new(&[]);
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    run.agent(tool_use("agent_1", "Agent", json!({"description": "look around", "run_in_background": true})));
    // The subagent's channel can be ahead of the session's own.
    run.sub("a1", WORKER, started("agent_1", "claude-haiku-5", true));
    run.sub("a1", WORKER, SubagentEventKind::Agent(tool_use("inner", "Read", json!({"file_path": "/x"}))));
    assert_eq!(run.tags(), ["turn:started", "msg:assistant:tool_call", "subagent_profile", "act:tool_started"]);
    run.agent(tool_result("agent_1", "Async agent launched successfully."));
    run.agent(turn_ended());
    assert_eq!(run.tags()[4..], ["msg:tool:tool_result", "subagent_started", "usage", "turn:ended"]);
    assert_eq!(
        run.json()[5],
        json!({"type": "subagent_started", "callId": "agent_1", "agentId": "a1", "background": true,
               "agentType": "general-purpose", "description": "look around"})
    );
    assert_eq!(run.mapper.live(), 1);

    let inner = |event: EngineEvent| SubagentEventKind::Agent(event);
    run.sub("a1", WORKER, inner(EngineEvent::BlockStart { index: 0, block: BlockKind::Text }));
    run.sub("a1", WORKER, inner(EngineEvent::TextDelta { text: "draft".into() }));
    run.sub("a1", WORKER, inner(EngineEvent::BlockStart { index: 0, block: BlockKind::Text }));
    run.sub("a1", WORKER, inner(EngineEvent::TextDelta { text: "final ".into() }));
    run.sub("a1", WORKER, inner(EngineEvent::TextDelta { text: "report".into() }));
    let used = Usage { input_tokens: Some(700), output_tokens: Some(50), ..Usage::default() };
    run.sub("a1", WORKER, ended("completed", used));
    assert_eq!(
        run.json().pop().expect("the completion"),
        json!({"type": "subagent_completed", "agentId": "a1", "callId": "agent_1", "status": "completed",
               "result": "final report", "usage": {"totalTokens": 750, "toolUses": 3, "durationMs": 1200}})
    );
    assert_eq!(run.mapper.live(), 0);

    // A message wakes it: a new run of the same subagent, filed under the message.
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    run.agent(tool_use("send_1", "SendMessage", json!({"to": "a1", "message": "one more thing"})));
    run.agent(tool_result("send_1", "resuming"));
    run.sub("a1", WORKER, started("agent_1", "claude-haiku-5", false));
    let resumed = run.json().pop().expect("the resume");
    assert_eq!((resumed["callId"].as_str(), resumed["resumes"].as_str()), (Some("send_1"), Some("agent_1")));
    run.sub("a1", WORKER, SubagentEventKind::Agent(tool_use("inner2", "Read", json!({}))));
    assert_eq!(run.json().pop().expect("the activity")["parentCallId"], "send_1");
    run.sub("a1", WORKER, ended("killed", Usage::default()));
    let stopped = run.json().pop().expect("the completion");
    assert_eq!((stopped["status"].as_str(), stopped["callId"].as_str()), (Some("stopped"), Some("send_1")));
}

#[test]
fn a_nested_subagent_shows_under_the_top_level_call_and_other_models_are_billed_apart() {
    let mut run = Run::new(&[]);
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    run.agent(tool_use("agent_1", "Agent", json!({})));
    run.agent(usage(100, 10, "claude-opus-5"));
    run.sub("a1", WORKER, started("agent_1", "claude-opus-5", false));
    run.sub("a1", WORKER, SubagentEventKind::Agent(usage(40, 4, "claude-opus-5")));
    run.sub("a2", "a1", started("inner_agent", "claude-haiku-5", false));
    run.sub("a2", "a1", SubagentEventKind::Agent(tool_use("deep", "Bash", json!({"command": "ls"}))));
    run.sub("a2", "a1", SubagentEventKind::Agent(usage(7, 1, "claude-haiku-5")));
    run.sub("a2", "a1", ended("completed", Usage::default()));
    run.sub("a1", WORKER, ended("completed", Usage::default()));
    run.agent(tool_result("agent_1", "report"));
    run.agent(turn_ended());
    let events = run.json();
    let deep = events.iter().find(|e| e["callId"] == "deep").expect("the nested tool");
    assert_eq!(deep["parentCallId"], "agent_1");
    assert_eq!(events.iter().filter(|e| e["type"] == "subagent_profile").count(), 1, "only the top-level subagent");
    let billed: Vec<&Value> = events.iter().filter(|e| e["type"] == "usage").map(|e| &e["usage"]).collect();
    assert_eq!(billed[0]["inputTokens"], 140, "the session's model: its own requests and same-model subagents");
    assert_eq!(billed[0]["model"], Value::Null);
    assert_eq!((billed[1]["inputTokens"].as_i64(), billed[1]["model"].as_str()), (Some(7), Some("claude-haiku-5")));
    assert_eq!(events.iter().filter(|e| e["type"] == "context").count(), 1, "a subagent's context is its own");
}

#[test]
fn background_commands_go_to_the_job_list_only() {
    let mut run = Run::new(&[]);
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    let dev = json!({"command": " npm run dev ", "description": "Dev server", "run_in_background": true});
    run.agent(tool_use("b1", "Bash", dev));
    run.agent(tool_use("m1", "Monitor", json!({"ws": {"url": "ws://localhost:1"}})));
    let before = run.out.len();
    let shell = |command: &str, file: Option<&str>| TaskEventKind::Started {
        task_type: "local_bash".into(),
        description: String::new(),
        workflow_name: None,
        run_id: None,
        transcript_dir: None,
        command: Some(command.to_owned()),
        output_file: file.map(str::to_owned),
    };
    run.task("t1", "b1", shell("npm run dev", Some("/d/tasks/t1.output")));
    run.task("t2", "m1", shell("", None));
    run.task("t1", "b1", TaskEventKind::Output { total_bytes: 10 });
    run.task("t2", "m1", TaskEventKind::Output { total_bytes: 10 });
    run.task("t2", "m1", TaskEventKind::Event { text: "build failed\nsee the log".into() });
    run.task("t9", "x1", TaskEventKind::Event { text: "a task this session never announced".into() });
    let end = TaskEventKind::Ended {
        status: "completed".into(),
        summary: "Background command \"Dev server\" completed (exit code 0)".into(),
        output_file: None,
        usage: TaskUsage::default(),
        workflow_progress: None,
        exit_code: Some(0),
    };
    run.task("t1", "b1", end);
    run.stop_live();
    assert_eq!(run.out.len(), before, "none of it is an agent event");
    let file = Some("/d/tasks/t1.output".to_owned());
    assert_eq!(
        *run.sink.tasks.lock().expect("tasks"),
        [
            BackgroundTaskUpdate::Started {
                task_id: "t1".into(),
                call_id: "b1".into(),
                kind: BackgroundTaskKind::Shell,
                title: "Dev server".into(),
                command: Some("npm run dev".into()),
                output_file: file.clone(),
            },
            BackgroundTaskUpdate::Started {
                task_id: "t2".into(),
                call_id: "m1".into(),
                kind: BackgroundTaskKind::Monitor,
                title: "Monitor".into(),
                command: Some("ws://localhost:1".into()),
                output_file: None,
            },
            BackgroundTaskUpdate::Output { task_id: "t1".into(), output_file: "/d/tasks/t1.output".into() },
            BackgroundTaskUpdate::Event { task_id: "t2".into(), text: "build failed\nsee the log".into() },
            BackgroundTaskUpdate::Ended {
                task_id: "t1".into(),
                outcome: TaskOutcome::Completed,
                summary: Some("Background command \"Dev server\" completed (exit code 0)".into()),
                output_file: file,
                exit_code: Some(0),
            },
            BackgroundTaskUpdate::Ended {
                task_id: "t2".into(),
                outcome: TaskOutcome::Stopped,
                summary: None,
                output_file: None,
                exit_code: None,
            },
        ]
    );
}

#[test]
fn a_session_that_goes_away_reports_its_background_work_stopped() {
    let mut run = Run::new(&[]);
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    run.agent(tool_use("agent_1", "Agent", json!({})));
    run.agent(tool_use("wf_1", "Workflow", json!({})));
    run.sub("a1", WORKER, started("agent_1", "", true));
    let start = TaskEventKind::Started {
        task_type: "local_workflow".into(),
        description: "Review".into(),
        workflow_name: Some("review".into()),
        run_id: Some("wf_abc".into()),
        transcript_dir: None,
        command: None,
        output_file: None,
    };
    run.task("task_w", "wf_1", start);
    let rows = json!([{"type": "workflow_agent", "index": 1, "label": "scan", "state": "progress", "startedAt": 1}]);
    let progress = TaskEventKind::Progress {
        description: String::new(),
        usage: TaskUsage::default(),
        last_tool_name: None,
        summary: None,
        workflow_progress: Some(raw(&rows)),
    };
    run.task("task_w", "wf_1", progress);
    assert_eq!(run.mapper.live(), 2);
    let before = run.out.len();
    run.stop_live();
    let closing: Vec<Value> = run.json().split_off(before);
    // The starts that still waited for their launch rows go out first.
    assert_eq!(
        closing.iter().map(tag).collect::<Vec<_>>(),
        ["subagent_started", "workflow_started", "subagent_completed", "workflow_completed"]
    );
    assert_eq!((closing[2]["status"].as_str(), closing[2]["callId"].as_str()), (Some("stopped"), Some("agent_1")));
    assert_eq!(closing[3]["status"], "stopped");
    assert_eq!(closing[3]["snapshot"]["agents"][0]["state"], "cancelled", "an open agent ends with its run");
    assert_eq!(run.mapper.live(), 0);
    run.stop_live();
    assert_eq!(run.out.len(), before + 4, "reported once");
}

#[test]
fn a_failed_turn_says_why_and_ends_in_an_error() {
    let mut run = Run::new(&[]);
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    run.agent(EngineEvent::BlockStart { index: 0, block: BlockKind::Thinking });
    run.agent(EngineEvent::ThinkingDelta { text: "hmm".into() });
    run.failed(Some("The request failed: overloaded"));
    assert_eq!(
        run.tags(),
        [
            "turn:started",
            "delta:reasoning:start",
            "msg:assistant:reasoning",
            "msg:assistant:text",
            "usage",
            "turn:error"
        ]
    );
    let events = run.json();
    assert_eq!(events[3]["blocks"][0]["text"], "The request failed: overloaded");
    assert_eq!(events[5]["reason"], "error_during_execution");

    // A failure something else already told the user about: no notice.
    run.failed(None);
    assert_eq!(run.tags()[6..], ["turn:started", "usage", "turn:error"]);

    // A turn that could not start answers why, and ends as an answered one.
    let side = Side { sink: &run.sink, worker_id: WORKER, now_ms: run.now_ms };
    let declined = run.mapper.turn_declined("Not signed in", &side);
    run.out.extend(declined);
    assert_eq!(run.tags()[9..], ["turn:started", "msg:assistant:text", "usage", "turn:ended"]);
    assert_eq!(run.json()[12]["reason"], Value::Null);
}

#[test]
fn a_restarted_stream_closes_its_live_blocks_and_starts_new_ones() {
    let mut run = Run::new(&[]);
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    run.agent(EngineEvent::BlockStart { index: 0, block: BlockKind::Text });
    run.agent(EngineEvent::TextDelta { text: "half".into() });
    run.agent(EngineEvent::StreamRestarted);
    run.agent(EngineEvent::RequestStarted { attempt: 2 });
    run.agent(EngineEvent::BlockStart { index: 0, block: BlockKind::Text });
    run.agent(EngineEvent::TextDelta { text: "whole".into() });
    run.agent(EngineEvent::BlockStop { index: 0 });
    run.agent(turn_ended());
    let events = run.json();
    assert_eq!(
        run.tags(),
        [
            "turn:started",
            "delta:text:start",
            "delta:text:stop",
            "delta:text:start",
            "delta:text:stop",
            "msg:assistant:text",
            "usage",
            "turn:ended"
        ]
    );
    assert_eq!((events[2]["blockId"].as_str(), events[3]["blockId"].as_str()), (Some("L-1:0"), Some("L-2:0")));
    assert_eq!(events[5]["blocks"][0]["text"], "whole", "only the attempt that finished is recorded");
}

#[test]
fn a_subagents_profile_names_its_model_and_effort_once_and_again_when_they_change() {
    let mut run = Run::new(&[]);
    run.agent(EngineEvent::RequestStarted { attempt: 1 });
    run.agent(tool_use("agent_1", "Agent", json!({"description": "look around", "run_in_background": true})));
    run.sub("a1", WORKER, started_at("agent_1", "claude-haiku-5", Some("medium"), true));
    let profiles =
        |run: &Run| -> Vec<Value> { run.json().into_iter().filter(|e| e["type"] == "subagent_profile").collect() };
    assert_eq!(
        profiles(&run),
        [json!({"type": "subagent_profile", "callId": "agent_1", "model": "claude-haiku-5", "effort": "medium"})]
    );
    // Woken on the same profile: nothing new. On another effort: said again.
    run.sub("a1", WORKER, ended("completed", Usage::default()));
    run.sub("a1", WORKER, started_at("agent_1", "claude-haiku-5", Some("medium"), true));
    assert_eq!(profiles(&run).len(), 1);
    run.sub("a1", WORKER, ended("completed", Usage::default()));
    run.sub("a1", WORKER, started_at("agent_1", "claude-haiku-5", Some("high"), true));
    assert_eq!(profiles(&run).last().map(|p| p["effort"].clone()), Some(json!("high")));
    // A model that takes no effort says none.
    run.agent(tool_use("agent_2", "Agent", json!({})));
    run.sub("a2", WORKER, started_at("agent_2", "claude-3-haiku", None, false));
    let last = profiles(&run).last().cloned().expect("a profile");
    assert_eq!(last, json!({"type": "subagent_profile", "callId": "agent_2", "model": "claude-3-haiku"}));
}
