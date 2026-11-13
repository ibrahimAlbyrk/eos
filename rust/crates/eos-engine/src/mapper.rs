//! Engine events → canonical agent events (`manager/backends/sdk/SdkEventMapper.ts`).
//!
//! One mapper per session. It turns what the engine reports about a session
//! — its own events, its subagents', its background tasks' — into the events
//! the event log, the dashboard and the phone read, in the shapes and order
//! the TypeScript mapper produced for the same conversation:
//!
//! - text and reasoning stream as `delta` events and are recorded as one
//!   `message` per finished block, with the block id its deltas used;
//! - a top-level tool is a `tool_call` block and a `tool_result` block, never
//!   an activity; a subagent's inner tools are activities under the call that
//!   started the subagent;
//! - one `usage` per turn (the sum of its requests), one `context` per
//!   request (the prompt's size), `turn` events at the turn's edges;
//! - background subagents and workflow runs start and end through their own
//!   events; a workflow's progress, background commands and a followed tool's
//!   input never become events: they go to the sink's side channels.

mod blocks;
mod convert;
mod tasks;
#[cfg(test)]
mod tests;
mod tracked;

use std::collections::HashMap;
use std::sync::Arc;

use eos_agent_core::{AgentEvent as EngineEvent, BlockKind, TaskEvent};
use eos_agent_sdk::{SubagentEvent, SubagentEventKind};
use eos_agent_types::StopReason;
use eos_contracts::{
    ActivityEvent, ActivityEventKind, AgentEvent, ContextEvent, SubagentCompletedEvent, SubagentCompletedEventStatus,
    SubagentProfileEvent, SubagentStartedEvent, SubagentUsage, TurnEventPhase,
};
use eos_core::agent::SessionSink;

use blocks::OpenBlocks;
use convert::{TurnUsage, object_of, result_text, turn};
use tasks::Tasks;
use tracked::{CallKind, Calls};

/// Where a mapper's side outputs go, and what time it is.
pub(crate) struct Side<'a> {
    pub(crate) sink: &'a dyn SessionSink,
    pub(crate) worker_id: &'a str,
    pub(crate) now_ms: i64,
}

/// One run of a subagent (its first turn, or a later one a message woke it for).
struct SubRun {
    /// The top-level call its tools are filed under.
    call_id: String,
    background: bool,
    /// The text of the reply it is writing: a background run's result.
    reply: String,
}

/// How many finished subagents are remembered, to recognise one that is woken.
const KNOWN_SUBAGENTS: usize = 256;

pub(crate) struct Mapper {
    /// Block ids are `<launch>-<request>:<index>`: unique per session launch.
    launch: String,
    requests: u64,
    turn_active: bool,
    open: OpenBlocks,
    usage: TurnUsage,
    /// The model the session's own requests run on, as the API names it.
    model: Option<String>,
    /// Usage of subagents on another model, billed at that model's price.
    other_usage: Vec<(String, TurnUsage)>,
    calls: Calls,
    /// Events that wait for their call's result row (see [`Calls`]).
    held: Vec<(String, AgentEvent)>,
    runs: HashMap<Arc<str>, SubRun>,
    /// Every subagent's first call, to tell a woken one from a new one.
    first_calls: HashMap<Arc<str>, String>,
    first_order: std::collections::VecDeque<Arc<str>>,
    /// The model and effort last reported for each top-level subagent call.
    profiles: HashMap<String, (String, Option<String>)>,
    tasks: Tasks,
}

impl Mapper {
    pub(crate) fn new(launch: String) -> Self {
        Self {
            launch,
            requests: 0,
            turn_active: false,
            open: OpenBlocks::default(),
            usage: TurnUsage::default(),
            model: None,
            other_usage: Vec::new(),
            calls: Calls::default(),
            held: Vec::new(),
            runs: HashMap::new(),
            first_calls: HashMap::new(),
            first_order: std::collections::VecDeque::new(),
            profiles: HashMap::new(),
            tasks: Tasks::default(),
        }
    }

    /// Background subagents and workflow runs still running. They live inside
    /// the session, so they end with it.
    pub(crate) fn live(&self) -> usize {
        self.runs.values().filter(|r| r.background).count() + self.tasks.live_workflows()
    }

    fn base(&self) -> String {
        format!("{}-{}", self.launch, self.requests)
    }

    fn start_turn(&mut self, out: &mut Vec<AgentEvent>) {
        if !self.turn_active {
            self.turn_active = true;
            out.push(turn(TurnEventPhase::Started, None));
        }
    }

    /// The turn is over: what was still streaming is recorded, the turn's
    /// usage reported, the turn closed.
    fn end_turn(&mut self, phase: TurnEventPhase, reason: Option<&str>, side: &Side<'_>, out: &mut Vec<AgentEvent>) {
        out.extend(self.open.cut(side));
        out.push(self.usage.take().event(None));
        for (model, usage) in self.other_usage.drain(..) {
            out.push(usage.event(Some(model)));
        }
        self.turn_active = false;
        out.push(turn(phase, reason));
    }

    /// One event of the session's own agent.
    pub(crate) fn agent(&mut self, event: EngineEvent, side: &Side<'_>) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        match event {
            EngineEvent::RequestStarted { .. } => {
                self.start_turn(&mut out);
                self.requests += 1;
            }
            EngineEvent::StreamRestarted => out.extend(self.open.abandon(side)),
            EngineEvent::BlockStart { index, block } => {
                self.start_turn(&mut out);
                let followed = matches!(&block, BlockKind::ToolUse { name, .. } if side.sink.follows_tool_input(name));
                self.open.start(format!("{}:{index}", self.base()), index, block, followed, side);
            }
            EngineEvent::TextDelta { text } => out.extend(self.open.text(text, false)),
            EngineEvent::ThinkingDelta { text } => out.extend(self.open.text(text, true)),
            EngineEvent::ToolInputDelta { id, partial_json } => self.open.tool_input(&id, &partial_json, side),
            EngineEvent::BlockStop { index } => out.extend(self.open.stop(index, side)),
            EngineEvent::ToolUse { id, name, input } => {
                self.start_turn(&mut out);
                let input = object_of(input.get());
                self.calls.note(&id, &name, &input);
                out.push(convert::tool_call(id, name, input));
            }
            EngineEvent::ToolResult { id, output } => {
                out.push(convert::tool_result(&id, &output));
                self.calls.result_seen(&id);
                self.release_held(&id, &mut out);
            }
            EngineEvent::Usage(response) => {
                // The size of this request's prompt is the context in use now.
                let tokens = response.usage.context_tokens();
                if tokens > 0 {
                    out.push(AgentEvent::Context(ContextEvent { tokens: tokens.into() }));
                }
                self.usage.add(&response.usage);
                if !response.model.is_empty() {
                    self.model = Some(response.model);
                }
            }
            EngineEvent::TurnEnded { stop_reason, .. } => {
                // The engine's turn limit is today's `error_max_turns` result.
                let limit = matches!(&stop_reason, StopReason::Other(name) if name == eos_agent_core::MAX_TURNS);
                if limit {
                    self.end_turn(TurnEventPhase::Error, Some("error_max_turns"), side, &mut out);
                } else {
                    self.end_turn(TurnEventPhase::Ended, None, side, &mut out);
                }
            }
            EngineEvent::Interrupted => self.end_turn(TurnEventPhase::Aborted, Some("interrupted"), side, &mut out),
            // The conversation's own messages are recorded from their blocks
            // and results; retries, limits and summaries are not events.
            EngineEvent::Message(_)
            | EngineEvent::RateLimit(_)
            | EngineEvent::Retrying { .. }
            | EngineEvent::Compacting { .. }
            | EngineEvent::Compacted { .. } => {}
        }
        out
    }

    /// The turn failed with no event of its own. `notice` is what the user
    /// reads about it; `None` when something else already told them.
    pub(crate) fn turn_failed(&mut self, notice: Option<&str>, side: &Side<'_>) -> Vec<AgentEvent> {
        self.turn_without_events(notice, TurnEventPhase::Error, Some("error_during_execution"), side)
    }

    /// The turn could not start, and `notice` says why and what to do: it
    /// is the turn's answer, and the turn ends as one that was answered.
    pub(crate) fn turn_declined(&mut self, notice: &str, side: &Side<'_>) -> Vec<AgentEvent> {
        self.turn_without_events(Some(notice), TurnEventPhase::Ended, None, side)
    }

    fn turn_without_events(
        &mut self,
        notice: Option<&str>,
        phase: TurnEventPhase,
        reason: Option<&str>,
        side: &Side<'_>,
    ) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        self.start_turn(&mut out);
        out.extend(self.open.cut(side));
        if let Some(text) = notice {
            self.requests += 1;
            out.push(convert::text(text.to_owned(), format!("{}:0", self.base())));
        }
        self.end_turn(phase, reason, side, &mut out);
        out
    }

    /// One event of a subagent of the session, at any depth.
    pub(crate) fn subagent(&mut self, event: SubagentEvent, side: &Side<'_>) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        let SubagentEvent { agent_id, parent_id, event } = event;
        match event {
            SubagentEventKind::Started(about) => {
                let top_level = &*parent_id == side.worker_id;
                let first = self.first_calls.get(&agent_id).cloned();
                // A subagent seen before is being woken: its new run is filed
                // under the message that woke it, when that is known.
                let call_id = match (&first, top_level) {
                    (Some(first), _) => self.calls.take_wake().unwrap_or_else(|| first.clone()),
                    (None, true) => about.tool_use_id.clone(),
                    // A subagent's subagent: everything shows under the top-level call.
                    (None, false) => {
                        self.runs.get(&parent_id).map_or_else(|| about.tool_use_id.clone(), |p| p.call_id.clone())
                    }
                };
                if first.is_none() {
                    self.remember_first(agent_id.clone(), call_id.clone());
                }
                let profile = (about.model.clone(), about.effort.clone());
                if top_level && !about.model.is_empty() && self.profiles.get(&call_id) != Some(&profile) {
                    self.profiles.insert(call_id.clone(), profile);
                    out.push(AgentEvent::SubagentProfile(SubagentProfileEvent {
                        call_id: call_id.clone(),
                        model: Some(about.model.clone()),
                        effort: about.effort.clone(),
                    }));
                }
                let background = about.background || first.is_some();
                if background && top_level {
                    let started = AgentEvent::SubagentStarted(SubagentStartedEvent {
                        call_id: call_id.clone(),
                        agent_id: agent_id.to_string(),
                        background: true,
                        resumes: first.filter(|f| *f != call_id),
                        agent_type: Some(about.agent_type.clone()).filter(|t| !t.is_empty()),
                        description: Some(about.description.clone()).filter(|d| !d.is_empty()),
                        output_file: None,
                    });
                    // Today's row order: the launching call's result, then the start.
                    if self.calls.awaits_result(&call_id) {
                        self.held.push((call_id.clone(), started));
                    } else {
                        out.push(started);
                    }
                }
                let run = SubRun { call_id, background: background && top_level, reply: String::new() };
                self.runs.insert(agent_id, run);
            }
            SubagentEventKind::Agent(inner) => {
                let Some(run) = self.runs.get_mut(&agent_id) else { return out };
                let parent = Some(Some(run.call_id.clone()));
                match inner {
                    EngineEvent::ToolUse { id, name, input } => out.push(AgentEvent::Activity(ActivityEvent {
                        kind: ActivityEventKind::ToolStarted,
                        call_id: Some(Some(id)),
                        tool_name: Some(name),
                        input: Some(object_of(input.get())),
                        parent_call_id: parent,
                        result: None,
                        is_error: None,
                    })),
                    EngineEvent::ToolResult { id, output } => out.push(AgentEvent::Activity(ActivityEvent {
                        kind: ActivityEventKind::ToolFinished,
                        call_id: Some(Some(id)),
                        tool_name: None,
                        input: None,
                        parent_call_id: parent,
                        result: Some(result_text(&output.content)),
                        is_error: Some(output.is_error),
                    })),
                    EngineEvent::BlockStart { block: BlockKind::Text, .. } if run.background => run.reply.clear(),
                    EngineEvent::TextDelta { text } if run.background => run.reply.push_str(&text),
                    EngineEvent::Usage(response) => {
                        if self.model.as_deref().is_none_or(|m| m == response.model) || response.model.is_empty() {
                            self.usage.add(&response.usage);
                        } else if let Some((_, usage)) = self.other_usage.iter_mut().find(|(m, _)| *m == response.model)
                        {
                            usage.add(&response.usage);
                        } else {
                            let mut usage = TurnUsage::default();
                            usage.add(&response.usage);
                            self.other_usage.push((response.model, usage));
                        }
                    }
                    _ => {}
                }
            }
            SubagentEventKind::Ended(ended) => {
                let Some(run) = self.runs.remove(&agent_id) else { return out };
                if !run.background {
                    return out;
                }
                self.release_held(&run.call_id, &mut out);
                let status = match ended.status {
                    "completed" => SubagentCompletedEventStatus::Completed,
                    "failed" => SubagentCompletedEventStatus::Failed,
                    _ => SubagentCompletedEventStatus::Stopped,
                };
                let total = ended.usage.context_tokens() + ended.usage.output_tokens.unwrap_or(0);
                out.push(AgentEvent::SubagentCompleted(SubagentCompletedEvent {
                    agent_id: agent_id.to_string(),
                    call_id: Some(Some(run.call_id)),
                    status,
                    result: Some(run.reply).filter(|r| !r.is_empty()).or(ended.error),
                    output_file: None,
                    usage: Some(SubagentUsage {
                        total_tokens: Some(total.into()),
                        tool_uses: Some(ended.tool_uses.into()),
                        duration_ms: Some(ended.duration_ms.into()),
                    }),
                }));
            }
        }
        out
    }

    /// One event of a background task of the session.
    pub(crate) fn task(&mut self, event: TaskEvent, side: &Side<'_>) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        // Only the session's own agent's tasks are shown; a subagent's are its own business.
        if event.agent_id != side.worker_id {
            return out;
        }
        if let Some((call_id, started)) = self.tasks.apply(event, &self.calls, side, &mut out) {
            if self.calls.awaits_result(&call_id) {
                self.held.push((call_id, started));
            } else {
                out.push(started);
            }
        }
        // A run that ended before its launch row was seen still starts first.
        if let Some(pos) = out.iter().position(|e| matches!(e, AgentEvent::WorkflowCompleted(_))) {
            let AgentEvent::WorkflowCompleted(done) = &out[pos] else { return out };
            let call = done.call_id.clone();
            let mut early = Vec::new();
            self.release_held(&call, &mut early);
            out.splice(pos..pos, early);
        }
        out
    }

    /// The session is going away: every background subagent and workflow run
    /// still running is reported stopped, once, and every background command
    /// closed, so none is left showing as running.
    pub(crate) fn stop_live(&mut self, side: &Side<'_>) -> Vec<AgentEvent> {
        let mut out: Vec<AgentEvent> = std::mem::take(&mut self.held).into_iter().map(|(_, e)| e).collect();
        let mut runs: Vec<(Arc<str>, SubRun)> = self.runs.drain().filter(|(_, r)| r.background).collect();
        runs.sort_by(|a, b| a.0.cmp(&b.0));
        for (agent_id, run) in runs {
            out.push(AgentEvent::SubagentCompleted(SubagentCompletedEvent {
                agent_id: agent_id.to_string(),
                call_id: Some(Some(run.call_id)),
                status: SubagentCompletedEventStatus::Stopped,
                result: None,
                output_file: None,
                usage: None,
            }));
        }
        self.tasks.stop_all(side, &mut out);
        out
    }

    fn release_held(&mut self, call_id: &str, out: &mut Vec<AgentEvent>) {
        let mut waiting = std::mem::take(&mut self.held);
        waiting.retain(|(call, event)| {
            let now = call == call_id;
            if now {
                out.push(event.clone());
            }
            !now
        });
        self.held = waiting;
    }

    fn remember_first(&mut self, agent_id: Arc<str>, call_id: String) {
        if self.first_order.len() >= KNOWN_SUBAGENTS
            && let Some(oldest) = self.first_order.pop_front()
        {
            self.first_calls.remove(&oldest);
        }
        self.first_order.push_back(agent_id.clone());
        self.first_calls.insert(agent_id, call_id);
    }
}

impl CallKind {
    /// Whether a call of `name` starts something the mapper follows.
    pub(crate) fn of(name: &str) -> Option<Self> {
        match name {
            "Agent" | "Task" => Some(Self::Agent),
            "SendMessage" => Some(Self::Wake),
            "Workflow" => Some(Self::Workflow),
            "Bash" => Some(Self::Shell),
            "Monitor" => Some(Self::Monitor),
            _ => None,
        }
    }
}
