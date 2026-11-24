//! The Forge's tools (06 §7.1): an orchestrator or an architect asks for a
//! capability Eos lacks (`request_capability`); a Forge session hands in
//! its stage's report (`forge_report`). Each call goes to the Forge
//! ([`Forge`]), which knows the caller's run. Needs and reports never reach
//! a log.

use std::sync::Arc;

use eos_core::BoxFuture;
use eos_core::forge::{Forge, ForgeAnswer, ForgeCaller, ForgeRequest, ForgeStage};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::schema::{object, one_of, record, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

struct RequestCapability(Arc<dyn Forge>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestArgs {
    need: String,
    routine_id: Option<String>,
}

impl Handler for RequestCapability {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let RequestArgs { need, routine_id } = args(input)?;
            let request = ForgeRequest {
                need,
                routine_id,
                capability_id: None,
                from_surface: None,
                caller: ForgeCaller::Agent { worker_id: call.self_id.to_owned() },
            };
            let answer = match self.0.request(request).await? {
                ForgeAnswer::Started { run_id } => json!({"forgeRun": run_id,
                    "next": "The Forge researches the ways now; the user picks one in Needs you."}),
                ForgeAnswer::Ready { capability_id } => json!({"capability": capability_id, "state": "ready",
                    "next": "It works already: call it with call_capability."}),
                ForgeAnswer::Setup { capability_id, step } => {
                    json!({"capability": capability_id, "setup": step, "next": "Tell the user this step."})
                }
            };
            Ok(Output::Json(answer))
        })
    }
}

struct ForgeReport(Arc<dyn Forge>);

#[derive(Deserialize)]
struct ReportArgs {
    stage: String,
    report: Value,
}

impl Handler for ForgeReport {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ReportArgs { stage, report } = args(input)?;
            let Some(stage) = ForgeStage::parse(&stage) else {
                return Err(Failure("stage: research, build or review".into()));
            };
            self.0.report(call.self_id, stage, report).await?;
            Ok(Output::text("Kept. Now tell the lead in one line, with send_message_to_parent."))
        })
    }
}

pub(crate) fn request_spec(forge: &Arc<dyn Forge>) -> Spec {
    Spec::new(
        "request_capability",
        object(vec![
            ("need", string().min(1).max(2000).describe("What is missing, in a plain sentence; or a capability's id.")),
            ("routineId", string().optional().describe("The routine that waits for it.")),
        ]),
        RequestCapability(forge.clone()),
    )
}

pub(crate) fn report_spec(forge: &Arc<dyn Forge>) -> Spec {
    Spec::new(
        "forge_report",
        object(vec![
            ("stage", one_of(&["research", "build", "review"]).describe("Your stage of the Forge.")),
            ("report", record().describe("The report, in the shape your brief gives.")),
        ]),
        ForgeReport(forge.clone()),
    )
    .always_load()
}
