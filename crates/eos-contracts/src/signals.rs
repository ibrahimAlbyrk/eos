//! The When slot of a routine's blueprint: what starts a run. Shapes only;
//! the rules over them (slots, validation) are `eos_domain::signals`, which
//! callers run on every value they take in.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

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
}
