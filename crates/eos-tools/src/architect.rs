//! The tools of a routine's architect: it reads the routine (`get_routine`),
//! writes the blueprint as a draft (`propose_blueprint`), asks the user one
//! question (`ask_choice`), looks at real items the routine would have taken
//! (`find_past_items`) and tries the draft on them (`start_trial`). Each call
//! goes to the routines feature ([`ArchitectTools`]), which knows the
//! caller's routine; a worker that is no architect is refused there.
//! Blueprints, questions and items never reach a log.

use std::sync::Arc;

use eos_contracts::{BlueprintIssue, IssueSeverity};
use eos_core::BoxFuture;
use eos_core::routine::{ArchitectTools, Proposal};
use serde::Deserialize;
use serde_json::Value;

use crate::schema::{array, int, object, record, string};
use crate::tool::{Call, Handler, Outcome, Output, Spec, args};

#[cfg(test)]
mod tests;

/// The worker definition an architect starts as.
pub(crate) const ARCHITECT_DEFINITION: &str = "eos-architect";

/// The most past items one call lists.
const PAST_ITEMS_MAX: u64 = 20;

struct GetRoutine(Arc<dyn ArchitectTools>);

impl Handler for GetRoutine {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move { Ok(Output::Json(self.0.get_routine(call.self_id).await?)) })
    }
}

struct ProposeBlueprint(Arc<dyn ArchitectTools>);

#[derive(Deserialize)]
struct ProposeArgs {
    blueprint: Value,
    note: Option<String>,
}

/// One finding a line: where in the blueprint, and what.
fn findings(issues: &[BlueprintIssue]) -> String {
    let line = |issue: &BlueprintIssue| {
        let place = if issue.path.is_empty() { "blueprint".to_owned() } else { issue.path.join(".") };
        format!("- {place}: {}", issue.message)
    };
    issues.iter().map(line).collect::<Vec<_>>().join("\n")
}

impl Handler for ProposeBlueprint {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ProposeArgs { blueprint, note } = args(input)?;
            let text = match self.0.propose_blueprint(call.self_id, blueprint, note).await? {
                Proposal::Drafted { warnings, .. } if warnings.is_empty() => "Draft written.".to_owned(),
                Proposal::Drafted { warnings, .. } => format!("Draft written, with warnings:\n{}", findings(&warnings)),
                Proposal::Refused(issues) => {
                    let errors: Vec<BlueprintIssue> =
                        issues.into_iter().filter(|issue| issue.severity == IssueSeverity::Error).collect();
                    format!("Not written. Fix these and propose again:\n{}", findings(&errors))
                }
            };
            Ok(Output::text(text))
        })
    }
}

struct AskChoice(Arc<dyn ArchitectTools>);

#[derive(Deserialize)]
struct ChoiceArgs {
    question: String,
    choices: Vec<String>,
}

impl Handler for AskChoice {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ChoiceArgs { question, choices } = args(input)?;
            self.0.ask_choice(call.self_id, &question, &choices).await?;
            // The answer is the user's next message.
            Ok(Output::EndTurn("Asked. The user's answer comes as their next message.".into()))
        })
    }
}

struct FindPastItems(Arc<dyn ArchitectTools>);

#[derive(Deserialize)]
struct PastArgs {
    limit: Option<u64>,
}

impl Handler for FindPastItems {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let PastArgs { limit } = args(input)?;
            let limit = limit.unwrap_or(10).min(PAST_ITEMS_MAX) as usize;
            let items = self.0.find_past_items(call.self_id, limit).await?;
            if items.is_empty() {
                return Ok(Output::text("No past items: a trial is one run without an item."));
            }
            Ok(Output::json(&items))
        })
    }
}

struct StartTrial(Arc<dyn ArchitectTools>);

impl Handler for StartTrial {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let runs = self.0.start_trial(call.self_id).await?;
            Ok(Output::text(format!("{} trial run(s) started. You hear how each ends.", runs.len())))
        })
    }
}

/// The architect's own tools. Sent with every request.
pub(crate) fn specs(tools: &Arc<dyn ArchitectTools>) -> Vec<Spec> {
    vec![
        Spec::new("get_routine", object(vec![]), GetRoutine(tools.clone())).always_load(),
        Spec::new(
            "propose_blueprint",
            object(vec![
                ("blueprint", record().describe("The whole blueprint, format 1.")),
                ("note", string().max(300).optional().describe("What changed, in one sentence.")),
            ]),
            ProposeBlueprint(tools.clone()),
        )
        .always_load(),
        Spec::new(
            "ask_choice",
            object(vec![
                ("question", string().min(1).max(300).describe("One question, in plain words.")),
                ("choices", array(string().min(1).max(80)).min(2).max(5).describe("The short answers to choose from.")),
            ]),
            AskChoice(tools.clone()),
        )
        .always_load(),
        Spec::new(
            "find_past_items",
            object(vec![(
                "limit",
                int().min(1).max(PAST_ITEMS_MAX).optional().describe("How many items at most; 10 when left out."),
            )]),
            FindPastItems(tools.clone()),
        )
        .always_load(),
        Spec::new("start_trial", object(vec![]), StartTrial(tools.clone())).always_load(),
    ]
}
