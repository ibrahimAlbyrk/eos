//! The user's memory as an agent reaches it (`search_memory`,
//! `suggest_memory`): it may look things up and propose, never write. And
//! what Eos learned from work (`recall_experience`): notes it may look up.

use std::sync::Arc;

use eos_contracts::{UserMemoryScope, UserMemorySuggestRequest};
use eos_core::BoxFuture;
use eos_core::experience::{ExperienceSearch, FoundNote};
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

/// How many notes a recall returns when the agent names no number.
const RECALL_LIMIT_DEFAULT: usize = 5;

struct RecallExperience(Arc<dyn ExperienceSearch>);

fn note_line(note: &FoundNote) -> String {
    let mark = if note.trust == eos_domain::experience::Trust::Guess
        || note.state == eos_domain::experience::NoteState::Trying
    {
        "hint"
    } else {
        "firm"
    };
    let scope = match note.scope.level {
        eos_domain::experience::ScopeLevel::Routine => "this routine",
        eos_domain::experience::ScopeLevel::Project => "this project",
        eos_domain::experience::ScopeLevel::Work => "this kind of work",
        eos_domain::experience::ScopeLevel::Everywhere => "everywhere",
    };
    let text: String = note.text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("- [{mark}] {text} ({}; {scope}, {})", note.id, note.state.as_str())
}

impl Handler for RecallExperience {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let SearchArgs { query, limit } = args(input)?;
            let notes = self.0.search(call.self_id, &query, limit.unwrap_or(RECALL_LIMIT_DEFAULT)).await?;
            if notes.is_empty() {
                return Ok(Output::text("Nothing learned matches."));
            }
            Ok(Output::Text(notes.iter().map(note_line).collect::<Vec<_>>().join("\n")))
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

pub(crate) fn specs(
    search: &Arc<dyn MemorySearch>,
    suggestions: &Arc<dyn MemorySuggestions>,
    experience: Option<&Arc<dyn ExperienceSearch>>,
) -> Vec<Spec> {
    let mut specs = vec![
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
    ];
    if let Some(experience) = experience {
        specs.push(Spec::new(
            "recall_experience",
            object(vec![
                (
                    "query",
                    string().min(1).max(200).describe(
                        "The situation, e.g. 'pushing to this repo' or the error you got. Paths and commands help.",
                    ),
                ),
                ("limit", int().min(1).max(10).optional().describe("Most notes to return (default 5).")),
            ]),
            RecallExperience(experience.clone()),
        ));
    }
    specs
}
