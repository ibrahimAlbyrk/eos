//! The tools of a routine run's sessions: the lead reports where the run is
//! (`report_progress`), hands in its result (`submit_result`) or says the run
//! cannot be done (`report_failure`); the checker gives its verdict on a
//! result (`submit_verdict`); a team's lead starts, follows up, stops and
//! lists its specialists (`start_specialist`, `message_specialist`,
//! `stop_specialist`, `list_specialists`). Each call goes to the routines feature
//! ([`RoutineTools`]), which knows the caller's run; a worker of no run is
//! refused there. Results, reasons and lines never reach a log.

use std::sync::Arc;

use eos_contracts::CheckVerdict;
use eos_core::BoxFuture;
use eos_core::routine::{RoutineTools, SubmittedResult};
use serde::Deserialize;
use serde_json::Value;

use crate::schema::{array, boolean, object, record, string, union};
use crate::tool::{Call, Handler, Outcome, Output, Spec, args};

/// The worker definitions a run's lead starts as.
pub(crate) const LEAD_DEFINITIONS: [&str; 3] = ["eos-run-solo", "eos-run-lead", "eos-run-script"];

/// The worker definition a team's lead starts as: the lead's tools and its team's.
pub(crate) const TEAM_LEAD_DEFINITION: &str = "eos-run-lead";

/// The worker definition a run's checker starts as.
pub(crate) const CHECKER_DEFINITION: &str = "eos-run-checker";

struct ReportProgress(Arc<dyn RoutineTools>);

#[derive(Deserialize)]
struct ProgressArgs {
    line: String,
    milestone: Option<String>,
}

impl Handler for ReportProgress {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ProgressArgs { line, milestone } = args(input)?;
            self.0.report_progress(call.self_id, &line, milestone.as_deref()).await?;
            Ok(Output::text("Noted."))
        })
    }
}

struct SubmitResult(Arc<dyn RoutineTools>);

#[derive(Deserialize)]
struct ResultArgs {
    kind: String,
    headline: String,
    body: Value,
    #[serde(default)]
    files: Vec<String>,
}

impl Handler for SubmitResult {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ResultArgs { kind, headline, body, files } = args(input)?;
            self.0.submit_result(call.self_id, SubmittedResult { kind, headline, body, files }).await?;
            // The lead waits while the result is checked; a finding comes back as a message.
            Ok(Output::EndTurn("Result handed in. It is being checked; wait for what comes back.".into()))
        })
    }
}

struct ReportFailure(Arc<dyn RoutineTools>);

#[derive(Deserialize)]
struct FailureArgs {
    reason: String,
}

impl Handler for ReportFailure {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let FailureArgs { reason } = args(input)?;
            self.0.report_failure(call.self_id, &reason).await?;
            Ok(Output::EndTurn("The run ended as failed.".into()))
        })
    }
}

struct SubmitVerdict(Arc<dyn RoutineTools>);

impl Handler for SubmitVerdict {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let verdict: CheckVerdict = args(input)?;
            self.0.submit_verdict(call.self_id, verdict).await?;
            Ok(Output::EndTurn("Verdict handed in.".into()))
        })
    }
}

/// The checker's one tool. Sent with every request.
pub(crate) fn checker_specs(tools: &Arc<dyn RoutineTools>) -> Vec<Spec> {
    let check = object(vec![
        ("key", string().min(1).describe("The check's key, as the brief lists it.")),
        ("ok", boolean().describe("Whether the result passes this check.")),
        ("note", string().describe("Why, in one sentence.")),
    ]);
    vec![
        Spec::new(
            "submit_verdict",
            object(vec![
                ("pass", boolean().describe("True only when every check holds.")),
                ("checks", array(check).describe("One entry per check of the routine.")),
                (
                    "mustFix",
                    array(string())
                        .default(serde_json::json!([]))
                        .describe("What the lead must change, one point each."),
                ),
            ]),
            SubmitVerdict(tools.clone()),
        )
        .always_load(),
    ]
}

/// The lead's three tools. Sent with every
/// request: a lead that has to search for how to end its run may not.
pub(crate) fn lead_specs(tools: &Arc<dyn RoutineTools>) -> Vec<Spec> {
    vec![
        Spec::new(
            "report_progress",
            object(vec![
                ("line", string().min(1).max(200).describe("Where the run is, in one short line.")),
                ("milestone", string().optional().describe("The key of the milestone worked on (project runs).")),
            ]),
            ReportProgress(tools.clone()),
        )
        .always_load(),
        Spec::new(
            "submit_result",
            object(vec![
                ("kind", string().min(1).describe("What the result is, as the brief's \"What it makes\" names it; `nothing` when there is nothing worth sending.")),
                ("headline", string().min(1).max(300).describe("One line the user reads first.")),
                ("body", union(vec![string(), record()]).describe("The result in the shape the brief asks for, or plain text.")),
                ("files", array(string()).max(20).optional().describe("Paths of files the result carries.")),
            ]),
            SubmitResult(tools.clone()),
        )
        .always_load(),
        Spec::new(
            "report_failure",
            object(vec![("reason", string().min(1).max(500).describe("Why the run cannot be done, in one plain sentence."))]),
            ReportFailure(tools.clone()),
        )
        .always_load(),
    ]
}

struct StartSpecialist(Arc<dyn RoutineTools>);

#[derive(Deserialize)]
struct StartArgs {
    agent: String,
    task: String,
}

impl Handler for StartSpecialist {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let StartArgs { agent, task } = args(input)?;
            self.0.start_specialist(call.self_id, &agent, &task).await?;
            Ok(Output::text(format!("{agent} started. Its report comes to you as a message.")))
        })
    }
}

struct MessageSpecialist(Arc<dyn RoutineTools>);

#[derive(Deserialize)]
struct MessageArgs {
    agent: String,
    text: String,
}

impl Handler for MessageSpecialist {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let MessageArgs { agent, text } = args(input)?;
            self.0.message_specialist(call.self_id, &agent, &text).await?;
            Ok(Output::text(format!("Sent to {agent}.")))
        })
    }
}

struct StopSpecialist(Arc<dyn RoutineTools>);

#[derive(Deserialize)]
struct AgentArgs {
    agent: String,
}

impl Handler for StopSpecialist {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let AgentArgs { agent } = args(input)?;
            self.0.stop_specialist(call.self_id, &agent).await?;
            Ok(Output::text(format!("{agent} stopped.")))
        })
    }
}

struct ListSpecialists(Arc<dyn RoutineTools>);

impl Handler for ListSpecialists {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let team = self.0.list_specialists(call.self_id).await?;
            let rows: Vec<Value> = team
                .into_iter()
                .map(|s| serde_json::json!({"agent": s.agent, "name": s.name, "state": s.state, "lastReport": s.last_report}))
                .collect();
            Ok(Output::text(serde_json::to_string_pretty(&rows).unwrap_or_default()))
        })
    }
}

/// A team lead's four tools for its specialists. Sent with every request.
pub(crate) fn team_specs(tools: &Arc<dyn RoutineTools>) -> Vec<Spec> {
    let agent = || string().min(1).describe("The specialist's key, as your brief lists it.");
    vec![
        Spec::new(
            "start_specialist",
            object(vec![
                ("agent", agent()),
                ("task", string().min(1).max(4000).describe("What the specialist should do now.")),
            ]),
            StartSpecialist(tools.clone()),
        )
        .always_load(),
        Spec::new(
            "message_specialist",
            object(vec![
                ("agent", agent()),
                ("text", string().min(1).max(4000).describe("What you need from it now.")),
            ]),
            MessageSpecialist(tools.clone()),
        )
        .always_load(),
        Spec::new("stop_specialist", object(vec![("agent", agent())]), StopSpecialist(tools.clone())).always_load(),
        Spec::new("list_specialists", object(vec![]), ListSpecialists(tools.clone())).always_load(),
    ]
}
