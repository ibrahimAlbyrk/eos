//! Naming a fresh orchestrator or focused chat from its first request
//! (`manager/modules/auto-name/autoName.ts`). It runs once, when the chat
//! first starts working, only while the name is still the random default,
//! and writes with a compare-and-set: a name the user chose is never
//! replaced.

use std::sync::Arc;

use eos_contracts::stream::topics::WORKER_CHANGE;
use eos_contracts::{FOCUSED_ROLE, NameSource};
use eos_core::store::{ConfigSource, EventOrder, EventQuery, Store};
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};

use crate::name::{interpret_model_output, is_nameable};
use crate::runner::{MicroTask, PromptValues};

pub const AUTO_NAME_TASK: &str = "auto-name";

/// A chat's opening request is among its first rows: a long history is never
/// loaded just to read it.
const EVENT_SCAN_LIMIT: i64 = 500;
const DEFAULT_CHAR_LIMIT: i64 = 280;

pub struct AutoName {
    pub store: Arc<dyn Store>,
    pub config: Arc<dyn ConfigSource>,
}

impl std::fmt::Debug for AutoName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutoName").finish_non_exhaustive()
    }
}

impl AutoName {
    /// The chat's opening request, or `None` before the user said anything.
    async fn user_input(&self, entity: &str) -> Result<Option<String>, Error> {
        let query = EventQuery {
            worker_id: entity.to_owned(),
            since: 0,
            limit: EVENT_SCAN_LIMIT,
            order: EventOrder::Asc,
            before_id: None,
            after_id: None,
        };
        let rows = self.store.read(move |tx| tx.events().list(&query)).await?;
        Ok(rows.into_iter().filter(|row| row.kind == "user_message").find_map(|row| {
            let payload: Value = serde_json::from_str(row.payload.as_deref()?).ok()?;
            payload["text"].as_str().filter(|text| !eos_domain::text::js_trim(text).is_empty()).map(str::to_owned)
        }))
    }
}

/// `text` cut to `max` UTF-16 units.
fn truncate(text: &str, max: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= max
        })
        .collect()
}

impl MicroTask for AutoName {
    fn id(&self) -> &'static str {
        AUTO_NAME_TASK
    }

    fn prompt_id(&self) -> &'static str {
        "micro-tasks/auto-name"
    }

    fn plugin(&self) -> Option<&'static str> {
        Some(eos_contracts::builtin_plugins::ids::AUTO_NAME)
    }

    fn topic(&self) -> &'static str {
        WORKER_CHANGE
    }

    /// Only the entry into WORKING from a state that is not busy: the chat's
    /// first turn, whether it was born with a prompt or messaged later.
    fn matches(&self, payload: &Value) -> Option<String> {
        if payload["state"] != "WORKING" || !matches!(payload["from"].as_str(), Some("SPAWNING" | "IDLE")) {
            return None;
        }
        payload["workerId"].as_str().map(str::to_owned)
    }

    fn gate<'a>(&'a self, entity: &'a str) -> BoxFuture<'a, Result<bool, Error>> {
        Box::pin(async move {
            let id = entity.to_owned();
            let row = self.store.read(move |tx| tx.workers().find(&id)).await?;
            // Top-level sessions only, and only the random default name.
            Ok(row.is_some_and(|row| {
                (row.is_orchestrator || row.agent_role.as_deref() == Some(FOCUSED_ROLE))
                    && row.name_source == Some(NameSource::Default)
            }))
        })
    }

    fn extract<'a>(&'a self, entity: &'a str) -> BoxFuture<'a, Result<Option<PromptValues>, Error>> {
        Box::pin(async move {
            let Some(input) = self.user_input(entity).await?.filter(|input| is_nameable(input)) else {
                return Ok(None);
            };
            let config = self.config.current();
            let limit = config.micro_tasks.tasks.get(AUTO_NAME_TASK).map_or(DEFAULT_CHAR_LIMIT, |c| c.char_limit);
            Ok(Some(vec![("USER_INPUT", truncate(&input, usize::try_from(limit).unwrap_or(0)))]))
        })
    }

    fn apply<'a>(&'a self, entity: &'a str, output: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            // The request the model saw, so an answer that parrots it is refused.
            let input = self.user_input(entity).await?.unwrap_or_default();
            let Some(name) = interpret_model_output(output, &input) else { return Ok(()) };
            let id = entity.to_owned();
            self.store
                .write(move |tx, out| {
                    if tx.workers().update_name_if_source(&id, &name, NameSource::Default, NameSource::Auto)? {
                        out.push(WORKER_CHANGE, &json!({"workerId": id}));
                    }
                    Ok(())
                })
                .await
        })
    }
}
