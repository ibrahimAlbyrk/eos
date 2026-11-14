//! Sending files to a paired computer (`send_to_machine`), for a focused session.

use std::sync::Arc;

use eos_contracts::{TransferRecord, TransferStatus};
use eos_core::agent::Refused;
use eos_core::transfer::AgentTransfers;
use eos_core::{BoxFuture, Clock, Sleeper};
use serde::Deserialize;
use serde_json::Value;

use crate::js::to_fixed;
use crate::schema::{array, object, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

/// How long the call follows the copy before it leaves it to run on.
const WAIT_MS: i64 = 60_000;
const POLL_MS: i64 = 1_500;

fn active(status: TransferStatus) -> bool {
    use TransferStatus::{Committing, Conflict, Copying, Queued, Scanning};
    matches!(status, Queued | Scanning | Copying | Conflict | Committing)
}

/// `1.4 MB`, `12 KB`: a size as the Transfer tab words it.
fn format_bytes(n: i64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    #[allow(clippy::cast_precision_loss)]
    let mut value = n as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{} {}", to_fixed(value, usize::from(value < 10.0)), UNITS[unit])
}

fn status_name(status: TransferStatus) -> String {
    serde_json::to_value(status).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The feature's own reason ("No paired Mac matches …"), not the status around it.
fn reason(e: Refused) -> Failure {
    Failure(e.message.strip_prefix("invalid request: ").unwrap_or(&e.message).to_owned())
}

struct SendToMachine {
    transfers: Arc<dyn AgentTransfers>,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
}

#[derive(Deserialize)]
struct SendArgs {
    machine: String,
    paths: Vec<String>,
}

/// What the agent is told about a transfer as it stands when the call returns.
fn outcome(t: &TransferRecord, machine: &str, sources: &[String]) -> Outcome {
    // The id lets the chat's card follow the transfer after the call.
    let tag = format!("({})", t.id.0);
    let roots: Vec<&str> = t.roots.iter().map(|r| r.name.as_str()).collect();
    let what = if roots.is_empty() { sources.join(", ") } else { roots.join(", ") };
    match t.status {
        TransferStatus::Done => {
            let placed: Vec<&str> = t.placed.iter().map(|p| p.path.as_str()).collect();
            Ok(Output::Text(format!(
                "Sent {what} ({}) to {machine}: {} {tag}",
                format_bytes(t.total_bytes),
                placed.join(", ")
            )))
        }
        status if active(status) => {
            let pct = if t.total_bytes > 0 { t.done_bytes * 100 / t.total_bytes } else { 0 };
            Ok(Output::Text(format!(
                "Still copying {what} to {machine} ({pct}%). It finishes in the background — the user sees it in the Transfer tab and gets a notification. {tag}"
            )))
        }
        TransferStatus::Paused | TransferStatus::Interrupted => Ok(Output::Text(format!(
            "The copy to {machine} stopped part-way ({}) — the user can resume it from the Transfer tab. {tag}",
            status_name(t.status)
        ))),
        TransferStatus::Cancelled => Ok(Output::Text(format!("The user cancelled sending {what}. {tag}"))),
        _ => Err(Failure(format!(
            "Sending {what} to {machine} failed: {} {tag}",
            t.error.as_ref().map_or("unknown error", |e| e.message.as_str())
        ))),
    }
}

impl Handler for SendToMachine {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let SendArgs { machine, paths } = args(input)?;
            let started = self.transfers.start(call.self_id, &machine, paths).await.map_err(reason)?;
            let deadline = self.clock.now_ms() + WAIT_MS;
            let mut latest = started.clone();
            while active(latest.status) && self.clock.now_ms() < deadline {
                self.sleeper.sleep(POLL_MS).await;
                // A failed read is a blip: the next one tells.
                if let Ok(now) = self.transfers.get(call.self_id, &started.id.0).await {
                    latest = now;
                }
            }
            outcome(&latest, &machine, &started.sources)
        })
    }
}

pub(crate) fn spec(transfers: &Arc<dyn AgentTransfers>, clock: &Arc<dyn Clock>, sleeper: &Arc<dyn Sleeper>) -> Spec {
    Spec::new(
        "send_to_machine",
        object(vec![
            (
                "machine",
                string()
                    .min(1)
                    .max(200)
                    .describe("The paired Mac to send to, by the name the user used — e.g. \"MacBook Air\"."),
            ),
            (
                "paths",
                array(string().min(1))
                    .min(1)
                    .max(100)
                    .describe("Files or folders on this Mac: absolute, or relative to your working folder."),
            ),
        ]),
        SendToMachine { transfers: transfers.clone(), clock: clock.clone(), sleeper: sleeper.clone() },
    )
}
