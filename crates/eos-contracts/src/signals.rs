//! The When and Which slots of a routine's blueprint: what starts a run, and
//! which items it takes. Shapes only; the rules over them (slots, validation,
//! matching) are `eos_domain::signals`, which callers run on every value they
//! take in. Every object keeps the keys this version does not know, after the
//! ones it knows (in a schedule, before `zone`), because a blueprint stores
//! these slots and a newer Eos may add a field to them that this one must not
//! drop.
//!
//! Beside the slots: what the signal and runner routes take and answer, and
//! the payloads of `signals:change` and `signals:subject`. These ignore the
//! keys they do not know, like every other wire type.

mod rows;
mod runners;

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::primitives::Num;
use crate::validate::Validate;

pub use rows::*;
pub use runners::*;

/// What starts a routine's run, and how many runs it takes on.
///
/// `{"on": [{"schedule": {…}}, {"source": "github.pulls", …}], "limits": {"perHour": 30, "queued": 25},
/// "batch": {"max": 50, "waitMinutes": 5}}`. No `on` entry: the routine starts only by hand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct When {
    pub on: Vec<Trigger>,
    #[serde(default)]
    pub limits: Limits,
    /// Several matched items wait for one run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<Batch>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for When {}

/// One thing that starts a run: one key naming the kind, except a
/// capability's source, whose scope and events sit beside `source`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Trigger {
    Schedule {
        schedule: Schedule,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// A signal source a capability declares (`github.pulls`), on one scope
    /// (`{"repo": "acme/game"}`), for some of its events.
    Source {
        source: String,
        scope: IndexMap<String, String>,
        events: Vec<String>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Folder {
        folder: FolderTrigger,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Git {
        git: GitTrigger,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// Another routine's run finished.
    After {
        after: AfterTrigger,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

impl Validate for Trigger {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FolderTrigger {
    pub path: String,
    /// A glob on the file's name (`*.pdf`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub names: Option<String>,
    pub events: Vec<FolderEvent>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for FolderTrigger {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FolderEvent {
    Added,
    Changed,
    Removed,
}

impl Validate for FolderEvent {}

/// New commits on a branch of a repository on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GitTrigger {
    pub repo: String,
    pub branch: String,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for GitTrigger {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AfterTrigger {
    /// The routine's id (`rt-…`).
    pub routine: String,
    pub outcome: AfterOutcome,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for AfterTrigger {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AfterOutcome {
    Done,
    Delivered,
    Any,
}

impl Validate for AfterOutcome {}

/// A routine's runs: at most `perHour` admitted in a rolling hour and
/// `queued` waiting. A field left out takes its default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    pub per_hour: i64,
    pub queued: i64,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Limits {
    fn default() -> Self {
        Self { per_hour: 30, queued: 25, extra: Map::new() }
    }
}

impl Validate for Limits {}

/// A batch closes when it holds `max` items, or `waitMinutes` after its first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub max: i64,
    pub wait_minutes: i64,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Batch {}

/// Which items start a run: rules over the facts a source gives, then, for
/// the items that pass, a question a small model answers.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct Which {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<Rule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Which {}

/// `{"all": [..]}`, `{"any": [..]}`, `{"not": {..}}`, or one test of one
/// fact: `{"fact": "draft", "is": false}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Rule {
    All {
        all: Vec<Rule>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Any {
        any: Vec<Rule>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Not {
        not: Box<Rule>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Test {
        fact: String,
        #[serde(flatten)]
        op: Op,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

impl Validate for Rule {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Is(Fact),
    /// The fact, or one of a list's items, is one of these.
    In(Vec<String>),
    /// A list holds this item.
    Has(String),
    /// The fact, or one of a list's items, matches this path glob.
    Glob(String),
    /// The fact, or one of a list's items, holds this text, whatever its case.
    Contains(String),
    Gte(Num),
    Lte(Num),
}

impl Validate for Op {}

/// What a source says about an item, by name (`repo`, `author`, `labels`,
/// `paths`, `draft`, `size`).
pub type Facts = IndexMap<String, Fact>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Fact {
    Bool(bool),
    Number(Num),
    Text(String),
    List(Vec<String>),
}

impl Validate for Fact {}

/// A clock schedule: when it repeats, on the wall clock of `zone` (an IANA
/// name such as `Europe/Istanbul`). Its repeat keeps the keys this version
/// does not know, so they are written after the repeat's fields and before
/// `zone`: a map beside the flattened repeat would hold its keys twice.
///
/// `{"daily": "05:00", "days": "weekdays", "zone": "Europe/Istanbul"}`,
/// `{"every": 30, "between": ["09:00", "17:00"], "days": "all", "zone": "UTC"}`,
/// `{"monthly": "last", "at": "18:00", "zone": "Europe/London"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Schedule {
    #[serde(flatten)]
    pub repeat: Repeat,
    pub zone: String,
}

impl Validate for Schedule {}

/// The three shapes a schedule takes. Times are `HH:MM` on the zone's clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Repeat {
    Daily {
        #[serde(rename = "daily")]
        at: String,
        days: Days,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// Every N minutes from midnight, or from the start of `between` up to
    /// its end.
    Every {
        #[serde(rename = "every")]
        minutes: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        between: Option<(String, String)>,
        days: Days,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// On a day of the month; a day the month lacks is its last day.
    Monthly {
        #[serde(rename = "monthly")]
        day: MonthDay,
        at: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

impl Validate for Repeat {}

/// `"all"`, `"weekdays"` (Monday to Friday) or a list of days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Days {
    Preset(DayPreset),
    List(Vec<Weekday>),
}

impl Validate for Days {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DayPreset {
    All,
    Weekdays,
}

impl Validate for DayPreset {}

/// Declared Monday first: the order is the day's number in the week.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Validate for Weekday {}

/// `1` to `31`, or `"last"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MonthDay {
    Day(i64),
    Last(LastDay),
}

impl Validate for MonthDay {}

/// The word `"last"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LastDay {
    Last,
}

impl Validate for LastDay {}

#[cfg(test)]
mod tests;
