//! `run:activity` (01 §6): what each of a run's agents is doing, one line
//! from its latest event (the tool it calls and what on, or the first line
//! of what it writes), at most one line a second per run. Lines are never
//! stored or logged. Each is published from a job of the ordered lane, so it
//! takes its place among the run's other events.

use eos_contracts::{AgentEvent, AgentMessageEventRole, ContentBlock, RunActivity};

use super::Engine;
use crate::RUN_ACTIVITY;

/// The shortest gap between two lines of one run.
const LINE_EVERY_MS: i64 = 1_000;
/// The longest line, in characters.
const LINE_MAX: usize = 120;

/// The inputs a tool's target is read from, in order.
const TARGETS: [&str; 6] = ["file_path", "path", "command", "pattern", "url", "agent"];

/// An agent event of a run session: a line for the run's view, unless the
/// run had one less than a second ago.
pub(crate) fn seen(engine: &Engine, worker_id: &str, event: &AgentEvent) {
    let bus = &engine.bus;
    let Some(line) = line_of(event) else { return };
    let Some(launch) = Engine::locked(&engine.launches).get(worker_id).cloned() else { return };
    let now = engine.clock.now_ms();
    {
        let mut last = Engine::locked(&engine.activity);
        if last.get(&launch.run_id).is_some_and(|at| now - at < LINE_EVERY_MS) {
            return;
        }
        last.insert(launch.run_id.clone(), now);
    }
    let payload = RunActivity {
        run_id: launch.run_id,
        worker_id: worker_id.to_owned(),
        agent_key: launch.agent_key,
        line,
        at: now,
    };
    let lane_bus = bus.clone();
    if bus.lane().post(move || lane_bus.publish(&RUN_ACTIVITY, &payload)).is_err() {
        tracing::debug!(worker_id, "a run's activity line was dropped: the lane is stopping");
    }
}

/// The line an event gives: its last tool call, else its text's first line.
fn line_of(event: &AgentEvent) -> Option<String> {
    let AgentEvent::Message(message) = event else { return None };
    if message.role != AgentMessageEventRole::Assistant {
        return None;
    }
    let tool = message.blocks.iter().rev().find_map(|block| match block {
        ContentBlock::ToolCall(call) => {
            let target = TARGETS.iter().find_map(|key| call.input.get(*key).and_then(|v| v.as_str()));
            Some(target.map_or_else(|| call.name.clone(), |target| format!("{} {target}", call.name)))
        }
        _ => None,
    });
    let text = || {
        message.blocks.iter().find_map(|block| match block {
            ContentBlock::Text(text) => {
                text.text.lines().map(str::trim).find(|line| !line.is_empty()).map(str::to_owned)
            }
            _ => None,
        })
    };
    let line = tool.or_else(text)?;
    Some(line.chars().take(LINE_MAX).collect())
}
