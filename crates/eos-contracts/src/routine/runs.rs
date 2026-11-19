//! Starting runs, and the topics that say how runs move.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use serde_json::Value;

use super::{ItemRef, RunInput, RunSummary, UsualCost};
use crate::primitives::Num;
use crate::validate::{Issues, Validate};

/// `POST /api/runs`: one run, or one per item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub routine_id: String,
    pub input: RunInput,
    /// Several items, one run each.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<ItemRef>>,
    /// The run this one does again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub again_of: Option<String>,
    /// Where the user started it (`home`, `routine_page`, …).
    pub door: String,
    /// Start although the routine handled the same item lately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_repeat: Option<bool>,
    /// The same id again answers the runs the first request made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
}

impl Validate for StartRunRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("input", |cx| self.input.validate(cx));
        cx.at("items", |cx| self.items.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartRunResponse {
    pub runs: Vec<StartedRun>,
}

impl Validate for StartRunResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartedRun {
    pub id: String,
    /// `queued`: a run starts once the supervisor lets it.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<i64>,
}

impl Validate for StartedRun {}

/// `run:change`: a run moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunChange {
    pub run_id: String,
    pub routine_id: String,
    pub state: String,
    /// None while it waits in the queue.
    pub station: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_user: Option<bool>,
}

impl Validate for RunChange {}

/// `run:activity`: what one of a run's agents is doing now, in one line.
/// Sent only to a tab that shows the run; never stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunActivity {
    pub run_id: String,
    pub worker_id: String,
    /// The agent of the routine's Who; `None` for the checker.
    pub agent_key: Option<String>,
    pub line: String,
    /// Epoch ms.
    pub at: i64,
}

impl Validate for RunActivity {}

/// `runs:active`: how many runs work, and how many wait on the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunsActive {
    pub count: i64,
    pub needs_user: i64,
}

impl Validate for RunsActive {}

/// What a run's check found: whether the result passes, each of the
/// routine's checks, and what the lead must change when it does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckVerdict {
    pub pass: bool,
    #[serde(default)]
    pub checks: Vec<CheckOutcome>,
    #[serde(default)]
    pub must_fix: Vec<String>,
}

impl Validate for CheckVerdict {}

/// One of the routine's checks, as the check found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    pub key: String,
    pub ok: bool,
    pub note: String,
}

impl Validate for CheckOutcome {}

/// `POST /api/runs/estimate`: what `count` runs of `input` will likely cost.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRequest {
    pub routine_id: String,
    pub input: RunInput,
    /// How many runs, one per item.
    #[serde(default = "one")]
    pub count: i64,
}

fn one() -> i64 {
    1
}

impl Validate for EstimateRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("input", |cx| self.input.validate(cx));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EstimateResponse {
    /// For all of them together.
    pub usd: Num,
    /// For one run.
    pub ms: i64,
    /// `history` (the routine's own runs), `trials` or `table`.
    pub basis: String,
    /// How many runs it was taken over.
    pub n: i64,
}

impl Validate for EstimateResponse {}

/// `GET /api/runs`: a page of runs, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub runs: Vec<RunSummary>,
    /// `before` for the next page; none on the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_before: Option<i64>,
}

impl Validate for RunPage {}

/// One session of a run, for the run view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunAgent {
    pub worker_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `solo`, `lead`, `script`, `specialist` or `checker`.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// The worker's state (`WORKING`, `IDLE`, …).
    pub state: String,
    pub cost_usd: Num,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<String>,
}

impl Validate for RunAgent {}

/// A run's timeline entry: ids, states and counts, never outside text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub id: i64,
    pub at: i64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Validate for RunEvent {}

/// `GET /api/runs/:id`: the run view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: RunSummary,
    pub input: RunInput,
    /// The check round, from 1.
    pub attempt: i64,
    pub agents: Vec<RunAgent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<CheckVerdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usual: Option<UsualCost>,
    pub events: Vec<RunEvent>,
}

impl Validate for RunDetail {}

/// `GET /api/runs/:id/result`: the result the run handed in last.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunResultBody {
    pub run_id: String,
    pub attempt: i64,
    pub kind: String,
    pub headline: String,
    pub body: Value,
    /// The files it carries: `{name, bytes}` each.
    pub files: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<CheckVerdict>,
    pub created_at: i64,
}

impl Validate for RunResultBody {}

/// `POST /api/runs/:id/message`: the user's words to the team.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunMessageRequest {
    pub text: String,
}

impl Validate for RunMessageRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("text", |cx| cx.str_min(self.text.trim(), 1));
    }
}

/// `GET /api/run-agents/:workerId`: the run a worker works for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentLookup {
    pub run_id: String,
    pub routine_id: String,
    pub role: String,
}

impl Validate for RunAgentLookup {}

/// `GET /api/routines/:id/candidates`: items to run on, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCandidates {
    pub items: Vec<ItemRef>,
}

impl Validate for RoutineCandidates {}
