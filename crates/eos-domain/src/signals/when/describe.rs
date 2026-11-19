//! A When slot in plain English, the routine row's trigger line: "Every
//! weekday at 05:00", "When a pull request opens or changes in
//! acme/game-client".

use eos_contracts::{AfterOutcome, DayPreset, Days, FolderEvent, MonthDay, Repeat, Schedule, Trigger, Weekday, When};

/// What starts the routine's runs, in one line.
pub fn describe(when: &When) -> String {
    if when.on.is_empty() {
        return "Only when you start it".to_owned();
    }
    let parts: Vec<String> = when.on.iter().map(trigger).collect();
    let mut line = parts[0].clone();
    for (i, part) in parts.iter().enumerate().skip(1) {
        line.push_str(if i + 1 == parts.len() { ", and " } else { ", " });
        line.push_str(&lower_first(part));
    }
    if let Some(batch) = &when.batch {
        line.push_str(&format!(", up to {} items a run", batch.max));
    }
    line
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

fn trigger(trigger: &Trigger) -> String {
    match trigger {
        Trigger::Schedule { schedule, .. } => clock(schedule),
        Trigger::Source { source, scope, events, .. } => {
            let (thing, verbs) = source_words(source);
            let happens = or_list(&events.iter().map(|event| verbs(event)).collect::<Vec<_>>());
            let scope: Vec<&str> = scope.values().map(String::as_str).collect();
            if scope.is_empty() {
                format!("When {thing} {happens}")
            } else {
                format!("When {thing} {happens} in {}", scope.join(", "))
            }
        }
        Trigger::Folder { folder, .. } => {
            let file = folder.names.as_ref().map_or_else(|| "a file".to_owned(), |names| format!("a {names} file"));
            let events: Vec<String> = folder
                .events
                .iter()
                .map(|event| match event {
                    FolderEvent::Added => "added",
                    FolderEvent::Changed => "changed",
                    FolderEvent::Removed => "removed",
                })
                .map(str::to_owned)
                .collect();
            format!("When {file} is {} in {}", or_list(&events), folder.path)
        }
        Trigger::Git { git, .. } => format!("When new commits reach {} in {}", git.branch, git.repo),
        Trigger::After { after, .. } => {
            let how = match after.outcome {
                AfterOutcome::Done => "finishes",
                AfterOutcome::Delivered => "delivers its result",
                AfterOutcome::Any => "ends",
            };
            format!("After a run of {} {how}", after.routine)
        }
    }
}

/// The thing a capability's source reports, and its events as verbs.
fn source_words(source: &str) -> (String, fn(&str) -> String) {
    match source {
        "github.pulls" => ("a pull request".to_owned(), pull_event),
        _ => (format!("{source} reports something that"), |event: &str| format!("is {event}")),
    }
}

fn pull_event(event: &str) -> String {
    match event {
        "opened" => "opens".to_owned(),
        "updated" => "changes".to_owned(),
        "ready" => "is ready for review".to_owned(),
        "closed" => "closes".to_owned(),
        "merged" => "is merged".to_owned(),
        other => format!("is {other}"),
    }
}

fn clock(schedule: &Schedule) -> String {
    match &schedule.repeat {
        Repeat::Daily { at, days, .. } => match days {
            Days::Preset(DayPreset::All) => format!("Every day at {at}"),
            Days::Preset(DayPreset::Weekdays) => format!("Every weekday at {at}"),
            Days::List(list) => format!("Every {} at {at}", and_list(&day_names(list))),
        },
        Repeat::Every { minutes, between, days, .. } => {
            let mut line = match minutes {
                60 => "Every hour".to_owned(),
                m if m % 60 == 0 => format!("Every {} hours", m / 60),
                m => format!("Every {m} minutes"),
            };
            if let Some((from, to)) = between {
                line.push_str(&format!(" between {from} and {to}"));
            }
            match days {
                Days::Preset(DayPreset::All) => {}
                Days::Preset(DayPreset::Weekdays) => line.push_str(" on weekdays"),
                Days::List(list) => line.push_str(&format!(" on {}", and_list(&day_names(list)))),
            }
            line
        }
        Repeat::Monthly { day, at, .. } => match day {
            MonthDay::Day(n) => format!("On the {} of every month at {at}", ordinal(*n)),
            MonthDay::Last(_) => format!("On the last day of every month at {at}"),
        },
    }
}

fn day_names(days: &[Weekday]) -> Vec<String> {
    days.iter()
        .map(|day| match day {
            Weekday::Mon => "Monday",
            Weekday::Tue => "Tuesday",
            Weekday::Wed => "Wednesday",
            Weekday::Thu => "Thursday",
            Weekday::Fri => "Friday",
            Weekday::Sat => "Saturday",
            Weekday::Sun => "Sunday",
        })
        .map(str::to_owned)
        .collect()
}

fn ordinal(n: i64) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// `a`, `a and b`, `a, b and c`.
fn and_list(items: &[String]) -> String {
    joined(items, "and")
}

/// `a`, `a or b`, `a, b or c`.
fn or_list(items: &[String]) -> String {
    joined(items, "or")
}

fn joined(items: &[String], word: &str) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [head @ .., last] => format!("{} {word} {last}", head.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn line(on: Value) -> String {
        describe(&serde_json::from_value(json!({ "on": on })).expect("a When"))
    }

    fn at(schedule: Value) -> String {
        line(json!([{ "schedule": schedule }]))
    }

    #[test]
    fn every_schedule_shape_reads_as_a_sentence() {
        let zone = "Europe/Istanbul";
        assert_eq!(at(json!({"daily": "05:00", "days": "weekdays", "zone": zone})), "Every weekday at 05:00");
        assert_eq!(at(json!({"daily": "07:30", "days": "all", "zone": zone})), "Every day at 07:30");
        assert_eq!(
            at(json!({"daily": "05:00", "days": ["mon", "wed", "fri"], "zone": zone})),
            "Every Monday, Wednesday and Friday at 05:00"
        );
        assert_eq!(at(json!({"every": 30, "days": "all", "zone": zone})), "Every 30 minutes");
        assert_eq!(at(json!({"every": 60, "days": "all", "zone": zone})), "Every hour");
        assert_eq!(
            at(json!({"every": 120, "between": ["09:00", "17:00"], "days": "weekdays", "zone": zone})),
            "Every 2 hours between 09:00 and 17:00 on weekdays"
        );
        assert_eq!(at(json!({"every": 90, "days": ["sat"], "zone": zone})), "Every 90 minutes on Saturday");
        assert_eq!(at(json!({"monthly": 1, "at": "18:00", "zone": zone})), "On the 1st of every month at 18:00");
        assert_eq!(at(json!({"monthly": 22, "at": "18:00", "zone": zone})), "On the 22nd of every month at 18:00");
        assert_eq!(at(json!({"monthly": 13, "at": "18:00", "zone": zone})), "On the 13th of every month at 18:00");
        assert_eq!(
            at(json!({"monthly": "last", "at": "18:00", "zone": zone})),
            "On the last day of every month at 18:00"
        );
    }

    #[test]
    fn every_trigger_kind_reads_as_a_sentence() {
        let pulls =
            json!({"source": "github.pulls", "scope": {"repo": "acme/game-client"}, "events": ["opened", "updated"]});
        assert_eq!(line(json!([pulls])), "When a pull request opens or changes in acme/game-client");
        let other = json!({"source": "mail.inbox", "scope": {}, "events": ["received"]});
        assert_eq!(line(json!([other])), "When mail.inbox reports something that is received");
        let folder = json!({"folder": {"path": "~/Invoices", "names": "*.pdf", "events": ["added", "changed"]}});
        assert_eq!(line(json!([folder])), "When a *.pdf file is added or changed in ~/Invoices");
        let folder = json!({"folder": {"path": "~/Drop", "events": ["removed"]}});
        assert_eq!(line(json!([folder])), "When a file is removed in ~/Drop");
        let git = json!({"git": {"repo": "~/code/game", "branch": "main"}});
        assert_eq!(line(json!([git])), "When new commits reach main in ~/code/game");
        for (outcome, how) in [("done", "finishes"), ("delivered", "delivers its result"), ("any", "ends")] {
            let after = json!({"after": {"routine": "rt-1", "outcome": outcome}});
            assert_eq!(line(json!([after])), format!("After a run of rt-1 {how}"));
        }
        assert_eq!(line(json!([])), "Only when you start it");
    }

    #[test]
    fn several_triggers_and_a_batch_make_one_line() {
        let when = json!({
            "on": [
                {"schedule": {"daily": "05:00", "days": "weekdays", "zone": "UTC"}},
                {"source": "github.pulls", "scope": {"repo": "acme/game"}, "events": ["ready"]},
                {"git": {"repo": "~/game", "branch": "main"}},
            ],
            "batch": {"max": 50, "waitMinutes": 5},
        });
        assert_eq!(
            describe(&serde_json::from_value(when).expect("a When")),
            "Every weekday at 05:00, when a pull request is ready for review in acme/game, and when new commits \
             reach main in ~/game, up to 50 items a run"
        );
    }
}
