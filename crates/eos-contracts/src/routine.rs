//! Routines: the blueprint a routine runs from (format 1), what one run is
//! given, and the rows and topic payload of the routine routes. Shapes only:
//! the blueprint's `impl Validate` is empty, so `parse` checks none of its
//! rules. Those, the formats this app reads, the canonical JSON and the hash
//! are `eos_domain::routine::blueprint`, which callers run on every blueprint
//! they take in. The When, Which, Freedom and Goes-to slots are the shapes of
//! `signals` and `freedom`.

mod input;
mod rows;

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use input::*;
pub use rows::*;

use crate::freedom::{Freedom, Recipient};
use crate::primitives::Num;
use crate::shared::Effort;
use crate::signals::{When, Which};
use crate::validate::Validate;

/// The blueprint format this version writes, runs and edits.
pub const BLUEPRINT_FORMAT: i64 = 1;

/// What a routine does, slot by slot. A version stores it as canonical JSON
/// and hashes it, so its bytes are fixed:
///
/// - the fields in the order declared here, then the keys this version does
///   not know, in the order they came; the same at every level of the slots
///   this module declares (When, Which, Freedom and Goes to keep only the
///   keys their own types know);
/// - an optional field left out when absent; a list or map written even when
///   empty;
/// - spelled as JavaScript's `JSON.stringify` writes it: no whitespace,
///   strings escaped as it escapes them, every number as ECMAScript's
///   `Number.prototype.toString` prints it (`5`, never `5.0`; `1e+21`).
///
/// The hash is the lowercase hex SHA-256 of those UTF-8 bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Blueprint {
    pub format: i64,
    pub name: String,
    /// One sentence.
    pub summary: String,
    /// A glyph name from the dashboard's set.
    pub icon: String,
    /// Words the Home input matches to this routine.
    #[serde(default)]
    pub aliases: Vec<String>,
    pub kind: RoutineKind,
    pub takes: Takes,
    #[serde(default)]
    pub options: Vec<RoutineOption>,
    pub when: When,
    pub which: Which,
    pub who: Who,
    pub how: How,
    pub makes: Makes,
    #[serde(default)]
    pub goes_to: Vec<Recipient>,
    pub freedom: Freedom,
    pub limits: RoutineLimits,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<RoutineProject>,
    /// The capabilities a run needs, kept as they came.
    #[serde(default)]
    pub needs: Vec<Value>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Blueprint {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RoutineKind {
    /// Runs again and again, one item at a time.
    Standing,
    /// One long run through milestones.
    Project,
    /// Runs once.
    Once,
}

impl Validate for RoutineKind {}

/// The item a run works on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Takes {
    /// The kind of item, as Eos or a capability names it.
    pub kind: String,
    /// The capability's source its items come from (`github.pulls`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// What one item is called.
    pub label: String,
    pub placeholder: String,
    pub empty: TakesEmpty,
    /// Several items may be chosen at once, one run each.
    pub many: bool,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Takes {}

/// What a run started without an item does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TakesEmpty {
    /// Takes the newest item.
    Latest,
    /// Runs without one.
    None,
    /// Is refused.
    Required,
}

impl Validate for TakesEmpty {}

/// A named setting a run may change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOption {
    pub key: String,
    pub label: String,
    pub r#type: OptionType,
    /// A choice's values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    /// The value a run takes when nobody sets one.
    pub default: Value,
    /// Shown in the run form itself rather than behind "More".
    pub inline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// Agents whose model or effort follows this option's value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affects: Option<Vec<OptionAffect>>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for RoutineOption {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OptionType {
    Choice,
    Bool,
    Text,
    Number,
}

impl Validate for OptionType {}

/// `{"agent": "editor", "model": {"deep": "opus"}, "effort": {"deep": "high"}}`:
/// the agent's model and effort for some of the option's values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OptionAffect {
    /// A Who agent's key.
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<IndexMap<String, Effort>>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for OptionAffect {}

/// The agents that do the work, and the one that checks it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Who {
    pub depth: WhoDepth,
    #[serde(default)]
    pub agents: Vec<RoutineAgent>,
    pub checker: RoutineChecker,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<RoutineScript>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Who {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WhoDepth {
    /// One agent.
    Solo,
    /// A lead and the agents it starts.
    Team,
    /// A script that runs the agents.
    Script,
}

impl Validate for WhoDepth {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineAgent {
    pub key: String,
    pub name: String,
    /// Leads a team: starts first, starts the others and submits the result.
    pub lead: bool,
    pub brief: String,
    pub model: String,
    pub effort: Effort,
    /// The agent's fence.
    pub tools: AgentTools,
    /// Reads text from outside (a pull request, a mail, a web page).
    pub reads_outside: bool,
    pub workspace: AgentWorkspace,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for RoutineAgent {}

/// Tool patterns an agent may and may not use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentTools {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for AgentTools {}

/// The folder an agent works in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentWorkspace {
    /// A scratch folder.
    None,
    /// The repository, without file edits.
    Read,
    /// Its own worktree of the repository.
    Worktree,
    /// The lead's worktree.
    Shared,
}

impl Validate for AgentWorkspace {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineChecker {
    pub model: String,
    pub effort: Effort,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for RoutineChecker {}

/// The workflow script a script routine runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineScript {
    pub source: String,
    /// The hex SHA-256 of `source`.
    pub hash: String,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for RoutineScript {}

/// How the work goes and how its result is checked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct How {
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub checks: Vec<RoutineCheck>,
    /// The shape of the result.
    pub format: String,
    /// A checker agent reads every result before it goes anywhere.
    pub check_agent: bool,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for How {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCheck {
    pub key: String,
    pub text: String,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for RoutineCheck {}

/// What a run makes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Makes {
    /// The kind of result, as Eos or a capability names it.
    pub kind: String,
    pub description: String,
    /// What a page result must hold, kept as it came.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<Value>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Makes {}

/// What one run, and the routine in a day, may spend, and how many of its
/// runs go at once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineLimits {
    pub per_run_usd: Num,
    pub per_run_minutes: i64,
    pub per_day_usd: Num,
    pub parallel: i64,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for RoutineLimits {}

/// A project routine's repository and milestones.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutineProject {
    pub repo: String,
    pub base_branch: String,
    pub brief: String,
    #[serde(default)]
    pub milestones: Vec<Milestone>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for RoutineProject {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub key: String,
    pub title: String,
    pub done_when: String,
    /// A step the feature that owns the routine runs instead of the lead
    /// (`forge.test`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Milestone {}

#[cfg(test)]
mod tests;
