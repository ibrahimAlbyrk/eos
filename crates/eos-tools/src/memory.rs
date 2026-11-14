//! The user's memory as an agent reaches it (`search_memory`,
//! `suggest_memory`): it may look things up and propose, never write.

use std::sync::Arc;

use eos_contracts::{UserMemoryScope, UserMemorySuggestRequest};
use eos_core::BoxFuture;
use eos_core::profile::{MemorySearch, MemorySuggestions};
use serde::Deserialize;
use serde_json::Value;

use crate::schema::{int, object, one_of, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

/// How many memories a search returns when the agent names no number.
const SEARCH_LIMIT_DEFAULT: usize = 8;

struct SearchMemory(Arc<dyn MemorySearch>);

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    limit: Option<usize>,
}

impl Handler for SearchMemory {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let SearchArgs { query, limit } = args(input)?;
            let memories = self.0.search(call.self_id, &query, limit.unwrap_or(SEARCH_LIMIT_DEFAULT)).await?;
            if memories.is_empty() {
                return Ok(Output::text("No memories match."));
            }
            let lines: Vec<String> = memories
                .iter()
                .map(|m| {
                    let here = if matches!(m.scope, UserMemoryScope::Project(_)) { "(this project) " } else { "" };
                    format!("- {here}{}", m.text)
                })
                .collect();
            Ok(Output::Text(lines.join("\n")))
        })
    }
}

struct SuggestMemory(Arc<dyn MemorySuggestions>);

impl Handler for SuggestMemory {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let request: UserMemorySuggestRequest = eos_contracts::read(&input)
                .map_err(|e| Failure::refused(eos_contracts::ValidationError::STATUS, &e.message()))?;
            let result = self.0.suggest(call.self_id, request).await?;
            // The id lets the chat's card follow the suggestion (kept, dismissed).
            let id = &result.memory.id.0;
            Ok(Output::Text(if result.declined {
                format!("Declined before ({id}): the user dismissed this idea. Don't suggest it again.")
            } else if result.duplicate {
                format!("Already known ({id}): \"{}\". Nothing to do.", result.memory.text)
            } else {
                format!("Suggested ({id}). The user reviews it in Eos before it is remembered — no need to mention it.")
            }))
        })
    }
}

pub(crate) fn specs(search: &Arc<dyn MemorySearch>, suggestions: &Arc<dyn MemorySuggestions>) -> Vec<Spec> {
    vec![
        Spec::new(
            "search_memory",
            object(vec![
                (
                    "query",
                    string().max(200).describe(
                        "Words to look for, e.g. 'commit style' or 'testing'. Empty lists the newest memories.",
                    ),
                ),
                ("limit", int().min(1).max(20).optional().describe("Most results to return (default 8).")),
            ]),
            SearchMemory(search.clone()),
        ),
        Spec::new(
            "suggest_memory",
            object(vec![
                (
                    "text",
                    string()
                        .min(1)
                        .max(500)
                        .describe("One self-contained sentence about the user, e.g. 'Prefers pnpm over npm.'"),
                ),
                (
                    "category",
                    one_of(&["about", "work-style", "stack", "other"]).describe(
                        "about = who the user is; work-style = how they want work done; stack = tools and technologies.",
                    ),
                ),
                (
                    "scope",
                    one_of(&["global", "project"]).describe(
                        "project = only true in the current project (its conventions); global = true everywhere.",
                    ),
                ),
                (
                    "why",
                    string()
                        .max(300)
                        .optional()
                        .describe("What the user said or did that shows it — shown to the user when they review."),
                ),
            ]),
            SuggestMemory(suggestions.clone()),
        ),
    ]
}
