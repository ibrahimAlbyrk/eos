use serde_json::{Value, json};

use super::*;

fn issues(when: Value) -> Vec<String> {
    let when: When = serde_json::from_value(when).expect("a when");
    let mut cx = Issues::default();
    validate(&when, &|zone| ["Europe/Istanbul", "UTC"].contains(&zone), None, &mut cx);
    cx.into_vec().iter().map(ToString::to_string).collect()
}

#[test]
fn the_plans_example_and_every_shape_at_its_bounds_are_valid() {
    let when = json!({
        "on": [
            {"source": "github.pulls", "scope": {"repo": "acme/game-client"}, "events": ["opened", "updated", "ready"]},
            {"schedule": {"daily": "05:00", "days": "weekdays", "zone": "Europe/Istanbul"}},
            {"schedule": {"every": 10, "between": ["09:00", "17:00"], "days": ["mon"], "zone": "UTC"}},
            {"schedule": {"every": 1440, "days": "all", "zone": "UTC"}},
            {"schedule": {"monthly": 31, "at": "23:59", "zone": "UTC"}},
            {"schedule": {"monthly": "last", "at": "00:00", "zone": "UTC"}},
            {"folder": {"path": "/Users/me/Inbox", "names": "*.pdf", "events": ["added"]}},
            {"git": {"repo": "/Users/me/game", "branch": "main"}},
            {"after": {"routine": "rt-0a1b2c3d4e5f", "outcome": "any"}},
        ],
        "limits": {"perHour": 200, "queued": 1},
        "batch": {"max": 2, "waitMinutes": 1440},
    });
    assert_eq!(issues(when), Vec::<String>::new());
    assert!(
        issues(json!({"on": [], "limits": {"perHour": 1, "queued": 100}, "batch": {"max": 200, "waitMinutes": 1}}))
            .is_empty()
    );
}

#[test]
fn each_schedule_error_names_where_it_is() {
    let on = json!([
        {"schedule": {"every": 5, "days": "all", "zone": "UTC"}},
        {"schedule": {"daily": "05:00", "days": "all", "zone": "Mars/Olympus"}},
        {"schedule": {"daily": "5:00", "days": [], "zone": "UTC"}},
        {"schedule": {"every": 30, "between": ["17:00", "09:00"], "days": "all", "zone": "UTC"}},
        {"schedule": {"every": 1441, "between": ["09:00", "25:00"], "days": "all", "zone": "UTC"}},
        {"schedule": {"monthly": 32, "at": "noon", "zone": "UTC"}},
        {"schedule": {"monthly": 0, "at": "12:00", "zone": "UTC"}},
    ]);
    assert_eq!(
        issues(json!({"on": on})),
        [
            "on.0.schedule.every: Number must be greater than or equal to 10",
            "on.1.schedule.zone: Unknown time zone",
            "on.2.schedule.daily: Expected a time as HH:MM",
            "on.2.schedule.days: Array must contain at least 1 element(s)",
            "on.3.schedule.between: The window must end after it starts",
            "on.4.schedule.every: Number must be less than or equal to 1440",
            "on.4.schedule.between.1: Expected a time as HH:MM",
            "on.5.schedule.monthly: Number must be less than or equal to 31",
            "on.5.schedule.at: Expected a time as HH:MM",
            "on.6.schedule.monthly: Number must be greater than or equal to 1",
        ]
    );
}

#[test]
fn each_other_trigger_limit_and_batch_error_names_where_it_is() {
    let when = json!({
        "on": [
            {"source": "", "scope": {}, "events": []},
            {"source": "github.pulls", "scope": {}, "events": [""]},
            {"folder": {"path": "", "names": "", "events": []}},
            {"git": {"repo": "", "branch": ""}},
            {"after": {"routine": "morning-paper", "outcome": "done"}},
        ],
        "limits": {"perHour": 0, "queued": 101},
        "batch": {"max": 1, "waitMinutes": 1441},
    });
    assert_eq!(
        issues(when),
        [
            "on.0.source: String must contain at least 1 character(s)",
            "on.0.events: Array must contain at least 1 element(s)",
            "on.1.events.0: String must contain at least 1 character(s)",
            "on.2.folder.path: String must contain at least 1 character(s)",
            "on.2.folder.names: String must contain at least 1 character(s)",
            "on.2.folder.events: Array must contain at least 1 element(s)",
            "on.3.git.repo: String must contain at least 1 character(s)",
            "on.3.git.branch: String must contain at least 1 character(s)",
            "on.4.after.routine: Invalid input: must start with \"rt-\"",
            "limits.perHour: Number must be greater than or equal to 1",
            "limits.queued: Number must be less than or equal to 100",
            "batch.max: Number must be greater than or equal to 2",
            "batch.waitMinutes: Number must be less than or equal to 1440",
        ]
    );
}

fn chains(edges: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    edges
        .iter()
        .map(|(routine, upstreams)| ((*routine).to_owned(), upstreams.iter().map(|u| (*u).to_owned()).collect()))
        .collect()
}

#[test]
fn a_loop_of_routines_running_after_one_another_is_found() {
    // A line and a diamond: no loop. An upstream nobody lists is a routine without triggers.
    assert_eq!(check_chains(&chains(&[("rt-a", &["rt-b"]), ("rt-b", &["rt-c"]), ("rt-c", &[])])), Ok(()));
    let diamond =
        chains(&[("rt-a", &["rt-b", "rt-c"]), ("rt-b", &["rt-d"]), ("rt-c", &["rt-d"]), ("rt-x", &["rt-gone"])]);
    assert_eq!(check_chains(&diamond), Ok(()));
    let looped = chains(&[("rt-x", &["rt-a"]), ("rt-a", &["rt-b"]), ("rt-b", &["rt-c"]), ("rt-c", &["rt-a"])]);
    assert_eq!(check_chains(&looped), Err(vec!["rt-a".to_owned(), "rt-b".to_owned(), "rt-c".to_owned()]));
    assert_eq!(check_chains(&chains(&[("rt-a", &["rt-a"])])), Err(vec!["rt-a".to_owned()]));
    // The first routine's loop, though the walk meets another loop first.
    let both = chains(&[("rt-a", &["rt-x", "rt-b"]), ("rt-x", &["rt-y"]), ("rt-y", &["rt-x"]), ("rt-b", &["rt-a"])]);
    assert_eq!(check_chains(&both), Err(vec!["rt-a".to_owned(), "rt-b".to_owned()]));
    assert_eq!(check_chains(&[]), Ok(()));
}
