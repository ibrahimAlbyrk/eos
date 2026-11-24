//! Changing a routine by hand.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::RoutineSummary;
use crate::primitives::Num;
use crate::validate::{Issues, Validate};

/// The states a routine is set to by hand; a draft starts from its draft,
/// and deleting has its own route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RoutineHandState {
    Active,
    Paused,
    Archived,
}

impl Validate for RoutineHandState {}

/// `PUT /api/routines/:id/state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStateRequest {
    pub state: RoutineHandState,
}

impl Validate for RoutineStateRequest {}

/// `POST /api/routines`: a routine made by hand from a blueprint, as a draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoutineRequest {
    /// Read as any format; its limits take the defaults it leaves out.
    pub blueprint: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Validate for CreateRoutineRequest {}

/// `POST /api/routines/:id/copy`: "start another like this", a project's
/// copy with a brief of its own.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CopyRoutineRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
}

impl Validate for CopyRoutineRequest {}

/// `PUT /api/routines/:id/blueprint`: a new version from the one the editor
/// started from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeepVersionRequest {
    /// The version the edit started from; the write is refused when it is no
    /// longer the routine's newest.
    pub base_version_id: String,
    pub blueprint: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Validate for KeepVersionRequest {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    /// Blocks keeping the version.
    Error,
    /// Shown; the version is kept.
    Warning,
}

impl Validate for IssueSeverity {}

/// One finding of a blueprint's rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintIssue {
    /// Object keys and list indexes from the blueprint's root.
    pub path: Vec<String>,
    pub message: String,
    pub severity: IssueSeverity,
}

impl Validate for BlueprintIssue {}

/// A blueprint its rules refused: 400 with every finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintRefused {
    pub error: String,
    pub issues: Vec<BlueprintIssue>,
}

impl Validate for BlueprintRefused {}

/// What a write that made a version answers: the routine's row, the
/// version, and the warnings its blueprint was kept with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSaved {
    pub row: Option<RoutineSummary>,
    pub version_id: String,
    pub warnings: Vec<BlueprintIssue>,
}

impl Validate for RoutineSaved {}

/// Today's raise of the overall day budget; it ends at local midnight.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RaisedToday {
    /// `YYYY-MM-DD`, the user's local day it holds for.
    pub day: String,
    /// What everything may spend that day.
    pub usd: Num,
}

impl Validate for RaisedToday {
    fn validate(&self, cx: &mut Issues) {
        cx.at("usd", |cx| cx.num_min(self.usd, 0.0, true));
    }
}

/// `GET /api/routines/settings`: the budgets for all routines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSettings {
    /// What every routine together may spend a day.
    pub day_budget_usd: Num,
    pub max_parallel_runs: i64,
    /// The share of the plan's five-hour window from which runs by triggers wait.
    pub plan_headroom_pct: i64,
    /// Absent unless raised for today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raised_today: Option<RaisedToday>,
}

impl Validate for RoutineSettings {}

/// `PUT /api/routines/settings`: the settings it names change.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_budget_usd: Option<Num>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel_runs: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_headroom_pct: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raised_today: Option<RaisedToday>,
}

impl Validate for RoutineSettingsPatch {
    fn validate(&self, cx: &mut Issues) {
        if let Some(usd) = self.day_budget_usd {
            cx.at("dayBudgetUsd", |cx| {
                cx.num_min(usd, 0.5, true);
                cx.num_max(usd, 5000.0, true);
            });
        }
        if let Some(runs) = self.max_parallel_runs {
            cx.at("maxParallelRuns", |cx| {
                cx.int_min(runs, 1, true);
                cx.int_max(runs, 3, true);
            });
        }
        if let Some(pct) = self.plan_headroom_pct {
            cx.at("planHeadroomPct", |cx| {
                cx.int_min(pct, 1, true);
                cx.int_max(pct, 100, true);
            });
        }
        if let Some(raised) = &self.raised_today {
            cx.at("raisedToday", |cx| raised.validate(cx));
        }
    }
}
