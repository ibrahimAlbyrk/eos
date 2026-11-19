//! What the signal routes take and answer, and what `signals:change` and
//! `signals:subject` carry. Decisions and states travel as the words
//! `eos_domain::signals` stores them.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{Schedule, Which};
use crate::primitives::de;
use crate::routine::ItemRef;
use crate::validate::{Issues, Validate};

/// The most signals one replay takes.
pub const REPLAY_MAX_SIGNALS: usize = 200;

/// The most slots a schedule preview gives.
pub const SCHEDULE_PREVIEW_MAX: i64 = 10;

/// The most recent signals a Which preview tries.
pub const WHICH_PREVIEW_MAX: i64 = 200;

/// A row of `GET /api/signals`: one signal, and what became of it for each
/// routine it was routed to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalRow {
    /// Arrival order.
    pub id: i64,
    pub source_id: String,
    /// What happened, as its source names it (`opened`, `updated`).
    pub kind: String,
    /// The thing it is about (`github:pr:acme/game#482`).
    pub subject: String,
    /// The subject's version (a pull request's head commit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub occurred_at: i64,
    pub received_at: i64,
    /// `received` or `routed`.
    pub state: String,
    /// The item a run of it takes.
    pub item: ItemRef,
    pub decisions: Vec<SignalDecision>,
}

impl Validate for SignalRow {}

/// What became of one signal for one routine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalDecision {
    pub routine_id: String,
    /// The routine's version when it was decided.
    pub routine_version: String,
    /// `run`, `batched`, `unmatched`, `undecided`, `unsorted`, `over-limit`,
    /// `superseded`, `paused`, `baseline`, `elsewhere`, `held-dev`, `refused`
    /// or `cancelled`.
    pub decision: String,
    /// A short code (`dev-run`), or for `unmatched` the index of the first
    /// rule that failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// The routine's question went to the model.
    pub model_asked: bool,
    pub decided_at: i64,
}

impl Validate for SignalDecision {}

/// The query of `GET /api/signals`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalListQuery {
    /// Only the signals routed to this routine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine: Option<String>,
    /// Only the signals decided so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    /// Only signals older than this id: the next page.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::coerce_int_opt")]
    pub before: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::coerce_int_opt")]
    pub limit: Option<i64>,
}

impl Validate for SignalListQuery {}

/// A row of `GET /api/signals/routines`: when one routine runs next, and
/// whether what starts it works.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineNext {
    pub routine_id: String,
    /// The soonest slot of its schedules; none without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_at: Option<i64>,
    /// The device id of the computer that acts on its triggers; none while
    /// no lease is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
    /// Every source it reads is `active`.
    pub sources_ok: bool,
}

impl Validate for RoutineNext {}

/// `GET /api/signals/routines/{routineId}`: what starts one routine's runs,
/// and how that went.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineTriggerStatus {
    pub routine_id: String,
    /// The computer that acts on its triggers; none while no lease is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<RoutineHolder>,
    /// One per schedule of its When, in their order.
    pub schedules: Vec<ScheduleStatus>,
    pub sources: Vec<SourceStatus>,
    /// The items waiting for one run together.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<OpenBatch>,
    /// Since the start of the user's day.
    pub counts_today: SignalCounts,
    pub counts7d: SignalCounts,
}

impl Validate for RoutineTriggerStatus {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHolder {
    pub device_id: String,
    /// The computer's name, from its device record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// This computer.
    pub here: bool,
    /// When its last heartbeat came, once it is over two hours old.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_since: Option<i64>,
}

impl Validate for RoutineHolder {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStatus {
    /// Its place in the When list.
    pub slot: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_at: Option<i64>,
    /// The last slot that fired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_at: Option<i64>,
    /// How late the last slot fired.
    pub late_by_ms: i64,
    /// Slots that passed while Eos was closed or the computer slept, and ran
    /// as one.
    pub missed: i64,
    pub zone: String,
    /// The schedule's zone is not this computer's.
    pub zone_differs: bool,
}

impl Validate for ScheduleStatus {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source_id: String,
    /// `clock`, `manual`, `capability`, `folder`, `git`, `after` or
    /// `push-inbox`.
    pub kind: String,
    /// A capability's source (`github.pulls`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// `active`, `backing-off`, `needs-attention`, `off` or `stopped`.
    pub state: String,
    /// `unreachable`, `unauthorized`, `gone`, `no-access` or `rate-limited`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_poll_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_poll_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_signal_at: Option<i64>,
    /// The last poll after a gap of over 15 minutes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catch_up: Option<CatchUp>,
}

impl Validate for SourceStatus {}

/// What one poll after a gap found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatchUp {
    pub at: i64,
    pub items: i64,
    pub gap_ms: i64,
}

impl Validate for CatchUp {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenBatch {
    pub items: i64,
    /// When its first item came.
    pub opened_at: i64,
    /// When it closes unless it fills first.
    pub closes_at: i64,
}

impl Validate for OpenBatch {}

/// Signals counted over a window that ends now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalCounts {
    /// In runs that reached the user or finished: each item of a batch run
    /// counts, a schedule's slot counts one.
    pub handled: i64,
    /// Of those, the ones waiting for the user.
    pub waiting: i64,
    /// Decided `unmatched`.
    pub ignored: i64,
    /// Decided `over-limit`, `undecided`, `unsorted`, `paused` or `held-dev`.
    pub held_back: i64,
    /// In runs that failed.
    pub failed: i64,
    /// Schedule slots that ran as one later slot.
    pub missed: i64,
    /// Schedule runs that started over five minutes after their slot.
    pub late: i64,
}

impl Validate for SignalCounts {}

/// `GET /api/signals/summary?since=`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalSummary {
    pub since: i64,
    pub counts: SignalCounts,
    /// The same counts by routine id.
    pub by_routine: IndexMap<String, SignalCounts>,
}

impl Validate for SignalSummary {}

/// `POST /api/signals/replay`: decide these signals of one routine again, as
/// if they had just come.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplayRequest {
    pub routine_id: String,
    pub signal_ids: Vec<i64>,
}

impl Validate for ReplayRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("signalIds", |cx| cx.arr_max(self.signal_ids.len(), REPLAY_MAX_SIGNALS));
    }
}

/// `POST /api/signals/schedule/preview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SchedulePreviewRequest {
    pub schedule: Schedule,
    pub count: i64,
}

impl Validate for SchedulePreviewRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("count", |cx| {
            cx.int_min(self.count, 1, true);
            cx.int_max(self.count, SCHEDULE_PREVIEW_MAX, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SchedulePreviewResponse {
    /// The next slots, soonest first.
    pub next: Vec<i64>,
}

impl Validate for SchedulePreviewResponse {}

/// `POST /api/signals/which/preview`: a Which tried on recent signals, by
/// its rules only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WhichPreviewRequest {
    /// Try it on this routine's signals; without one, on every routine's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    pub which: Which,
    pub limit: i64,
}

impl Validate for WhichPreviewRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("limit", |cx| {
            cx.int_min(self.limit, 1, true);
            cx.int_max(self.limit, WHICH_PREVIEW_MAX, true);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WhichPreviewResponse {
    /// The signals the rules take.
    pub matched: Vec<i64>,
    /// The signals a rule turns away, by the first rule that failed.
    pub unmatched: Vec<RuleMisses>,
    /// The signals a fact the rules test was missing for.
    pub undecided: Vec<i64>,
    /// How many of the matched the model would be asked about.
    pub would_ask: i64,
}

impl Validate for WhichPreviewResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuleMisses {
    /// The rule's index.
    pub rule: i64,
    pub signal_ids: Vec<i64>,
}

impl Validate for RuleMisses {}

/// `PUT /api/signals/settings`, and what it answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalSettings {
    /// On mains power, keep the computer awake while a schedule is armed.
    pub keep_awake_for_schedules: bool,
}

impl Validate for SignalSettings {}

/// `signals:change`: what to read again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub what: SignalChangeWhat,
}

impl Validate for SignalChange {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SignalChangeWhat {
    /// Signals were decided.
    Routed,
    Schedule,
    Source,
    Runner,
    Settings,
}

impl Validate for SignalChangeWhat {}

/// `signals:subject`: a new version of a subject came in, matched or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignalSubject {
    pub subject_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The source says the subject is done (a pull request merged or closed).
    pub closed: bool,
}

impl Validate for SignalSubject {}

#[cfg(test)]
mod tests;
