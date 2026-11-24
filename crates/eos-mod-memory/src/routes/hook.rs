//! `POST /api/memory/hook {event, input}`: a Code-mode pane's Claude Code hook, through the
//! terminal's `eos memory hook` (04 G34). Answers within 300 ms with Claude Code's hook output
//! (`hookSpecificOutput.additionalContext`), or with `null`: a slow recall gives nothing rather
//! than hold the tool. Never logs the input.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::ExperienceHookRequest;
use eos_runtime::access::Access;
use eos_runtime::http::{ApiError, Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::{Value, json};

use crate::reminders::Reminders;

/// How long a hook may hold the tool it runs before.
pub(crate) const WITHIN: Duration = Duration::from_millis(300);
/// The hooks a pane runs (`eos-mod-terminals`' launch).
const EVENTS: [&str; 4] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUseFailure"];

pub(crate) fn route(reminders: Arc<Reminders>) -> RouteDef {
    RouteDef::post("/api/memory/hook", move |req: Request| {
        let reminders = reminders.clone();
        async move {
            let ExperienceHookRequest { event, input } = req.parse()?;
            if !EVENTS.contains(&event.as_str()) {
                return Err(ApiError::Validation(format!("invalid request: event: {event} is no pane hook")));
            }
            let found = tokio::time::timeout(WITHIN, reminders.pane(&event, &input)).await.ok().flatten();
            let answer = found.map_or(
                Value::Null,
                |text| json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": text } }),
            );
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::ui_token().local_only())
}
