//! The When and Which slots of a routine's blueprint: what starts a run, and
//! which items it takes. Shapes only; the rules over them (slots, validation,
//! matching) are `eos_domain::signals`, which callers run on every value they
//! take in.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::Num;
use crate::validate::Validate;

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
}

impl Validate for When {}

/// One thing that starts a run: one key naming the kind, except a
/// capability's source, whose scope and events sit beside `source`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Trigger {
    Schedule {
        schedule: Schedule,
    },
    /// A signal source a capability declares (`github.pulls`), on one scope
    /// (`{"repo": "acme/game"}`), for some of its events.
    Source {
        source: String,
        scope: IndexMap<String, String>,
        events: Vec<String>,
    },
    Folder {
        folder: FolderTrigger,
    },
    Git {
        git: GitTrigger,
    },
    /// Another routine's run finished.
    After {
        after: AfterTrigger,
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
}

impl Validate for GitTrigger {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AfterTrigger {
    /// The routine's id (`rt-…`).
    pub routine: String,
    pub outcome: AfterOutcome,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    pub per_hour: i64,
    pub queued: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Self { per_hour: 30, queued: 25 }
    }
}

impl Validate for Limits {}

/// A batch closes when it holds `max` items, or `waitMinutes` after its first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub max: i64,
    pub wait_minutes: i64,
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
}

impl Validate for Which {}

/// `{"all": [..]}`, `{"any": [..]}`, `{"not": {..}}`, or one test of one
/// fact: `{"fact": "draft", "is": false}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Rule {
    All {
        all: Vec<Rule>,
    },
    Any {
        any: Vec<Rule>,
    },
    Not {
        not: Box<Rule>,
    },
    Test {
        fact: String,
        #[serde(flatten)]
        op: Op,
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
/// name such as `Europe/Istanbul`).
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
    },
    /// Every N minutes from midnight, or from the start of `between` up to
    /// its end.
    Every {
        #[serde(rename = "every")]
        minutes: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        between: Option<(String, String)>,
        days: Days,
    },
    /// On a day of the month; a day the month lacks is its last day.
    Monthly {
        #[serde(rename = "monthly")]
        day: MonthDay,
        at: String,
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
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(value: serde_json::Value) -> Schedule {
        let schedule: Schedule = crate::read(&value).unwrap();
        assert_eq!(serde_json::to_value(&schedule).unwrap(), value);
        schedule
    }

    #[test]
    fn each_schedule_shape_reads_and_writes_back_the_same() {
        let daily = round_trip(json!({"daily": "05:00", "days": "weekdays", "zone": "Europe/Istanbul"}));
        assert_eq!(daily.repeat, Repeat::Daily { at: "05:00".into(), days: Days::Preset(DayPreset::Weekdays) });
        let every =
            round_trip(json!({"every": 30, "between": ["09:00", "17:00"], "days": ["mon", "fri"], "zone": "UTC"}));
        assert_eq!(
            every.repeat,
            Repeat::Every {
                minutes: 30,
                between: Some(("09:00".into(), "17:00".into())),
                days: Days::List(vec![Weekday::Mon, Weekday::Fri]),
            }
        );
        round_trip(json!({"every": 10, "days": "all", "zone": "UTC"}));
        let monthly = round_trip(json!({"monthly": "last", "at": "18:00", "zone": "Europe/London"}));
        assert_eq!(monthly.repeat, Repeat::Monthly { day: MonthDay::Last(LastDay::Last), at: "18:00".into() });
        round_trip(json!({"monthly": 31, "at": "08:30", "zone": "Asia/Kolkata"}));
    }

    #[test]
    fn unknown_fields_are_ignored_and_a_missing_zone_is_required() {
        let schedule: Schedule = crate::read(&json!({"daily": "05:00", "days": "all", "zone": "UTC", "x": 1})).unwrap();
        assert_eq!(serde_json::to_value(&schedule).unwrap(), json!({"daily": "05:00", "days": "all", "zone": "UTC"}));
        assert!(crate::read::<Schedule>(&json!({"daily": "05:00", "days": "all"})).is_err());
        assert!(crate::read::<Schedule>(&json!({"weekly": "05:00", "days": "all", "zone": "UTC"})).is_err());
        assert!(crate::read::<Schedule>(&json!({"daily": "05:00", "days": "sometimes", "zone": "UTC"})).is_err());
    }

    #[test]
    fn the_plans_when_and_which_read_and_write_back_the_same() {
        let when = json!({
            "on": [
                {"source": "github.pulls", "scope": {"repo": "acme/game-client"}, "events": ["opened", "updated", "ready"]},
                {"schedule": {"daily": "05:00", "days": "weekdays", "zone": "Europe/Istanbul"}},
            ],
            "limits": {"perHour": 30, "queued": 25},
        });
        let read: When = crate::read(&when).unwrap();
        assert!(matches!(&read.on[0], Trigger::Source { source, .. } if source == "github.pulls"));
        assert!(matches!(&read.on[1], Trigger::Schedule { .. }));
        assert_eq!(serde_json::to_value(&read).unwrap(), when);

        let which = json!({
            "rule": {"all": [
                {"fact": "draft", "is": false},
                {"fact": "paths", "glob": "Assets/Scripts/**"},
                {"not": {"fact": "author", "in": ["dependabot[bot]"]}},
            ]},
            "ask": "Is this change about networking?",
        });
        let read: Which = crate::read(&which).unwrap();
        let Some(Rule::All { all }) = &read.rule else { panic!("an all rule") };
        assert_eq!(all[0], Rule::Test { fact: "draft".into(), op: Op::Is(Fact::Bool(false)) });
        assert_eq!(serde_json::to_value(&read).unwrap(), which);
    }

    #[test]
    fn every_trigger_reads_and_writes_back_the_same() {
        for trigger in [
            json!({"folder": {"path": "/Users/me/Inbox", "names": "*.pdf", "events": ["added", "changed", "removed"]}}),
            json!({"folder": {"path": "/Users/me/Inbox", "events": ["added"]}}),
            json!({"git": {"repo": "/Users/me/game", "branch": "main"}}),
            json!({"after": {"routine": "rt-0a1b2c3d4e5f", "outcome": "delivered"}}),
        ] {
            let read: Trigger = crate::read(&trigger).unwrap();
            assert_eq!(serde_json::to_value(&read).unwrap(), trigger);
        }
        let any = json!({"fact": "size", "gte": 1.5});
        assert_eq!(serde_json::to_value(crate::read::<Rule>(&any).unwrap()).unwrap(), any);
        let whole = json!({"any": [{"fact": "labels", "has": "bug"}, {"fact": "size", "lte": 400}]});
        assert_eq!(serde_json::to_value(crate::read::<Rule>(&whole).unwrap()).unwrap(), whole);
    }

    #[test]
    fn limits_default_and_unknown_fields_are_ignored() {
        let when: When = crate::read(&json!({"on": [], "limits": {"perHour": 5}, "later": true})).unwrap();
        assert_eq!(when.limits, Limits { per_hour: 5, queued: 25 });
        let bare: When = crate::read(&json!({"on": []})).unwrap();
        assert_eq!((bare.limits, bare.batch), (Limits { per_hour: 30, queued: 25 }, None));
        let batched: When = crate::read(&json!({"on": [], "batch": {"max": 50, "waitMinutes": 5}})).unwrap();
        assert_eq!(batched.batch, Some(Batch { max: 50, wait_minutes: 5 }));
        let rule: Rule = crate::read(&json!({"fact": "draft", "is": true, "note": "x"})).unwrap();
        assert_eq!(rule, Rule::Test { fact: "draft".into(), op: Op::Is(Fact::Bool(true)) });
        assert!(crate::read::<Rule>(&json!({"fact": "draft"})).is_err(), "a test needs an operator");
        assert!(crate::read::<When>(&json!({"limits": {}})).is_err(), "on is required");
    }
}
