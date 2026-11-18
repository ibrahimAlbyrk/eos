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
    assert_eq!(
        daily.repeat,
        Repeat::Daily { at: "05:00".into(), days: Days::Preset(DayPreset::Weekdays), extra: Map::new() }
    );
    let every = round_trip(json!({"every": 30, "between": ["09:00", "17:00"], "days": ["mon", "fri"], "zone": "UTC"}));
    assert_eq!(
        every.repeat,
        Repeat::Every {
            minutes: 30,
            between: Some(("09:00".into(), "17:00".into())),
            days: Days::List(vec![Weekday::Mon, Weekday::Fri]),
            extra: Map::new(),
        }
    );
    round_trip(json!({"every": 10, "days": "all", "zone": "UTC"}));
    let monthly = round_trip(json!({"monthly": "last", "at": "18:00", "zone": "Europe/London"}));
    assert_eq!(
        monthly.repeat,
        Repeat::Monthly { day: MonthDay::Last(LastDay::Last), at: "18:00".into(), extra: Map::new() }
    );
    round_trip(json!({"monthly": 31, "at": "08:30", "zone": "Asia/Kolkata"}));
}

#[test]
fn unknown_fields_are_kept_and_a_missing_zone_is_required() {
    let schedule: Schedule = crate::read(&json!({"daily": "05:00", "days": "all", "zone": "UTC", "x": 1})).unwrap();
    assert_eq!(serde_json::to_string(&schedule).unwrap(), r#"{"daily":"05:00","days":"all","x":1,"zone":"UTC"}"#);
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
    let Some(Rule::All { all, .. }) = &read.rule else { panic!("an all rule") };
    assert_eq!(all[0], Rule::Test { fact: "draft".into(), op: Op::Is(Fact::Bool(false)), extra: Map::new() });
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
fn limits_default_and_unknown_fields_are_kept() {
    let when: When = crate::read(&json!({"on": [], "limits": {"perHour": 5}, "later": true})).unwrap();
    assert_eq!(when.limits, Limits { per_hour: 5, ..Limits::default() });
    assert_eq!(when.extra, json!({"later": true}).as_object().unwrap().clone());
    let bare: When = crate::read(&json!({"on": []})).unwrap();
    assert_eq!((bare.limits, bare.batch), (Limits { per_hour: 30, queued: 25, extra: Map::new() }, None));
    let batched: When = crate::read(&json!({"on": [], "batch": {"max": 50, "waitMinutes": 5}})).unwrap();
    assert_eq!(batched.batch, Some(Batch { max: 50, wait_minutes: 5, extra: Map::new() }));
    let rule: Rule = crate::read(&json!({"fact": "draft", "is": true, "note": "x"})).unwrap();
    let note = json!({"note": "x"}).as_object().unwrap().clone();
    assert_eq!(rule, Rule::Test { fact: "draft".into(), op: Op::Is(Fact::Bool(true)), extra: note });
    assert!(crate::read::<Rule>(&json!({"fact": "draft"})).is_err(), "a test needs an operator");
    assert!(crate::read::<When>(&json!({"limits": {}})).is_err(), "on is required");
}

/// Reads `text` as a `T` and writes it back.
fn rewritten<T: serde::de::DeserializeOwned + Serialize>(text: &str) -> String {
    let value: Value = serde_json::from_str(text).unwrap();
    serde_json::to_string(&crate::read::<T>(&value).unwrap()).unwrap()
}

#[test]
fn every_object_keeps_the_keys_it_does_not_know_after_the_ones_it_knows() {
    let when = concat!(
        r#"{"on":["#,
        r#"{"schedule":{"daily":"05:00","days":"all","d":1,"zone":"UTC"},"t":1},"#,
        r#"{"schedule":{"every":30,"between":["09:00","17:00"],"days":["mon"],"e":1,"zone":"UTC"},"t":2},"#,
        r#"{"schedule":{"monthly":"last","at":"18:00","m":1,"zone":"UTC"},"t":3},"#,
        r#"{"source":"github.pulls","scope":{"repo":"acme/game"},"events":["opened"],"t":4},"#,
        r#"{"folder":{"path":"/in","events":["added"],"f":1},"t":5},"#,
        r#"{"git":{"repo":"/game","branch":"main","g":1},"t":6},"#,
        r#"{"after":{"routine":"rt-a","outcome":"done","a":1},"t":7}],"#,
        r#""limits":{"perHour":30,"queued":25,"l":1},"batch":{"max":2,"waitMinutes":1,"b":1},"w":{"x":[1]}}"#,
    );
    assert_eq!(rewritten::<When>(when), when);
    let which = concat!(
        r#"{"rule":{"all":["#,
        r#"{"fact":"draft","is":false,"t":1},"#,
        r#"{"any":[{"fact":"labels","has":"bug"}],"y":1},"#,
        r#"{"not":{"fact":"author","in":["bot"]},"n":1}],"a":1},"#,
        r#""ask":"Networking?","q":null}"#,
    );
    assert_eq!(rewritten::<Which>(which), which);
    assert_eq!(
        rewritten::<When>(r#"{"z":1,"on":[{"t":1,"git":{"g":1,"branch":"main","repo":"/game"}}]}"#),
        r#"{"on":[{"git":{"repo":"/game","branch":"main","g":1},"t":1}],"limits":{"perHour":30,"queued":25},"z":1}"#,
        "known keys first, in their declared order"
    );
}
