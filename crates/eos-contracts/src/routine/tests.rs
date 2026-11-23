use serde_json::{Value, json};

use super::*;
use crate::freedom::Rung;

/// PR Review, every field in the declared order.
fn pr_review() -> Value {
    json!({
        "format": 1,
        "name": "PR Review",
        "summary": "Reviews each pull request of the game client.",
        "icon": "eye",
        "aliases": ["review"],
        "kind": "standing",
        "takes": {"kind": "github.pull_request", "source": "github.pulls", "label": "pull request",
                  "placeholder": "#470 or a link", "empty": "latest", "many": true},
        "options": [{"key": "depth", "label": "Depth", "type": "choice", "values": ["quick", "deep"],
                     "default": "quick", "inline": true,
                     "affects": [{"agent": "editor", "model": {"deep": "opus"}, "effort": {"deep": "high"}}]}],
        "when": {"on": [{"source": "github.pulls", "scope": {"repo": "acme/game"}, "events": ["opened"]}],
                 "limits": {"perHour": 30, "queued": 25}},
        "which": {"rule": {"fact": "draft", "is": false}},
        "who": {"depth": "team",
                "agents": [
                    {"key": "reader", "name": "Reader", "lead": false, "brief": "Read the diff.", "model": "haiku",
                     "effort": "low", "tools": {"allow": ["Read"], "deny": []}, "readsOutside": true,
                     "workspace": "read"},
                    {"key": "editor", "name": "Editor", "lead": true, "brief": "Write the review.",
                     "model": "sonnet", "effort": "medium", "tools": {"allow": [], "deny": []},
                     "readsOutside": false, "workspace": "worktree"}],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"steps": ["Read", "Write"], "checks": [{"key": "lines", "text": "Every comment names a line."}],
                "format": "review", "checkAgent": true},
        "makes": {"kind": "github.review", "description": "A pending review."},
        "goesTo": [{"id": "pr", "kind": "item_place", "channel": "github"}],
        "freedom": {"rung": "draft", "grants": []},
        "limits": {"perRunUsd": 2.5, "perRunMinutes": 30, "perDayUsd": 5, "parallel": 1},
        "needs": ["github"],
    })
}

#[test]
fn a_blueprint_reads_and_writes_back_in_the_declared_order() {
    let value = pr_review();
    let blueprint: Blueprint = crate::read(&value).unwrap();
    assert_eq!(blueprint.who.agents[1].effort, crate::Effort::Medium);
    assert_eq!(blueprint.freedom.rung, Rung::Draft);
    assert_eq!(serde_json::to_string(&blueprint).unwrap(), serde_json::to_string(&value).unwrap());
}

#[test]
fn unknown_keys_are_kept_after_the_known_ones_in_the_order_they_came() {
    let mut value = pr_review();
    let object = value.as_object_mut().unwrap();
    let name = object.shift_remove("name").unwrap();
    object.insert("later".into(), json!({"b": 1, "a": [2]}));
    object.insert("name".into(), name);
    object.insert("earlier".into(), json!(null));
    value["who"]["agents"][0]["temperature"] = json!(0.5);
    value["limits"]["perWeekUsd"] = json!(20);

    let written = serde_json::to_string(&crate::read::<Blueprint>(&value).unwrap()).unwrap();
    assert!(written.starts_with(r#"{"format":1,"name":"PR Review","summary""#), "{written}");
    assert!(written.ends_with(r#""needs":["github"],"later":{"b":1,"a":[2]},"earlier":null}"#), "{written}");
    assert!(written.contains(r#""workspace":"read","temperature":0.5}"#), "{written}");
    assert!(written.contains(r#""parallel":1,"perWeekUsd":20}"#), "{written}");
}

#[test]
fn lists_may_be_left_out_and_everything_else_is_required() {
    let mut value = pr_review();
    for key in ["aliases", "options", "goesTo", "needs"] {
        value.as_object_mut().unwrap().shift_remove(key);
    }
    let blueprint: Blueprint = crate::read(&value).unwrap();
    assert!(blueprint.aliases.is_empty() && blueprint.options.is_empty() && blueprint.needs.is_empty());

    let mut value = pr_review();
    value["who"]["agents"][0].as_object_mut().unwrap().shift_remove("readsOutside");
    let error = crate::read::<Blueprint>(&value).unwrap_err();
    assert_eq!(error.message(), "invalid request: who.agents.0.readsOutside: Required");

    let mut value = pr_review();
    value["who"]["depth"] = json!("crowd");
    assert!(crate::read::<Blueprint>(&value).is_err());
}

#[test]
fn a_run_input_reads_with_its_bounds() {
    let input: RunInput = crate::parse(&json!({
        "item": {"kind": "github.pull_request", "key": "github:pr:acme/game#482@abc", "untrusted": true},
        "result": "showOnly",
        "ignored": 1,
    }))
    .unwrap();
    assert_eq!(input.result, ResultMode::ShowOnly);
    assert_eq!(
        serde_json::to_value(&input).unwrap(),
        json!({"item": {"kind": "github.pull_request", "key": "github:pr:acme/game#482@abc", "untrusted": true},
               "options": {}, "result": "showOnly"})
    );

    let long_note = json!({"note": "x".repeat(RUN_NOTE_MAX_CHARS + 1), "result": "usual"});
    assert_eq!(
        crate::parse::<RunInput>(&long_note).unwrap_err().message(),
        "invalid request: note: String must contain at most 4000 character(s)"
    );
    let long_text = json!({"items": [{"kind": "text", "text": "x".repeat(ITEM_TEXT_MAX_BYTES + 1), "untrusted": false}], "result": "ask"});
    assert_eq!(
        crate::parse::<RunInput>(&long_text).unwrap_err().message(),
        "invalid request: items.0.text: Text must be at most 64 KiB"
    );
    let unsaid = json!({"item": {"kind": "text", "text": "hi"}, "result": "usual"});
    assert_eq!(crate::parse::<RunInput>(&unsaid).unwrap_err().message(), "invalid request: item.untrusted: Required");
}

#[test]
fn rows_write_as_the_dashboard_reads_them() {
    let gone = RoutineChange { routine_id: "rt-1".into(), reason: RoutineChangeReason::Deleted, row: None };
    assert_eq!(serde_json::to_value(&gone).unwrap(), json!({"routineId": "rt-1", "reason": "deleted"}));

    let version = RoutineVersion {
        row: RoutineVersionRow {
            id: "rv-1".into(),
            number: 2,
            parent_id: Some("rv-0".into()),
            status: VersionStatus::Kept,
            author: VersionAuthor::Architect,
            note: None,
            format: 2,
            runnable: false,
            created_at: 5,
        },
        hash: "ab".into(),
        blueprint: json!({"format": 2}),
    };
    assert_eq!(
        serde_json::to_string(&version).unwrap(),
        r#"{"id":"rv-1","number":2,"parentId":"rv-0","status":"kept","author":"architect","format":2,"runnable":false,"createdAt":5,"hash":"ab","blueprint":{"format":2}}"#
    );

    let blueprint: Blueprint = crate::read(&pr_review()).unwrap();
    let takes = RoutineTakes { takes: blueprint.takes, item_patterns: vec!["#(\\d+)".into()] };
    assert_eq!(
        serde_json::to_value(&takes).unwrap(),
        json!({"kind": "github.pull_request", "source": "github.pulls", "label": "pull request",
               "placeholder": "#470 or a link", "empty": "latest", "many": true, "itemPatterns": ["#(\\d+)"]})
    );
    let stats = RoutineStats {
        sent_unedited7d: Some(Num(0.9)),
        baseline_first_week: None,
        runs7d: 4,
        cost7d: Num(1.25),
        setup_usd: Num(0.4),
    };
    assert_eq!(
        serde_json::to_value(stats).unwrap(),
        json!({"sentUnedited7d": 0.9, "runs7d": 4, "cost7d": 1.25, "setupUsd": 0.4})
    );
}

#[test]
fn a_start_and_the_run_topics_read_and_write_back() {
    let body = json!({"routineId": "rt-1", "input": {"result": "usual", "options": {}},
                      "items": [{"kind": "github.pull_request", "key": "github:pr:acme/game#1", "untrusted": true}],
                      "door": "home", "confirmRepeat": true, "clientRequestId": "c-1"});
    let request: StartRunRequest = crate::parse(&body).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), body);
    let bare: StartRunRequest =
        crate::parse(&json!({"routineId": "rt-1", "input": {"result": "ask"}, "door": "phone"})).unwrap();
    assert_eq!((bare.items, bare.again_of, bare.confirm_repeat), (None, None, None));
    assert!(crate::parse::<StartRunRequest>(&json!({"routineId": "rt-1", "input": {"result": "ask"}})).is_err());

    let response =
        StartRunResponse { runs: vec![StartedRun { id: "rn-1".into(), state: "queued".into(), not_before: Some(5) }] };
    let written = json!({"runs": [{"id": "rn-1", "state": "queued", "notBefore": 5}]});
    assert_eq!(serde_json::to_value(&response).unwrap(), written);
    assert_eq!(crate::read::<StartRunResponse>(&written).unwrap(), response);

    let change = RunChange {
        run_id: "rn-1".into(),
        routine_id: "rt-1".into(),
        state: "queued".into(),
        station: None,
        reason: None,
        needs_user: None,
    };
    let written = json!({"runId": "rn-1", "routineId": "rt-1", "state": "queued", "station": null});
    assert_eq!(serde_json::to_value(&change).unwrap(), written);
    assert_eq!(crate::read::<RunChange>(&written).unwrap(), change);
    let failed = RunChange {
        state: "failed".into(),
        station: Some("check".into()),
        reason: Some("check_failed".into()),
        needs_user: Some(false),
        ..change
    };
    assert_eq!(
        serde_json::to_string(&failed).unwrap(),
        r#"{"runId":"rn-1","routineId":"rt-1","state":"failed","station":"check","reason":"check_failed","needsUser":false}"#
    );

    let active = RunsActive { count: 2, needs_user: 1 };
    assert_eq!(serde_json::to_value(active).unwrap(), json!({"count": 2, "needsUser": 1}));
    assert_eq!(crate::read::<RunsActive>(&json!({"count": 2, "needsUser": 1})).unwrap(), active);
}

#[test]
fn a_one_off_request_reads_with_its_bounds_and_its_answer_writes_back() {
    let body = json!({"text": "summarise this", "attachments": [{"kind": "file", "value": "/tmp/a.md"}],
                      "result": "usual", "door": "home"});
    let request: OnceRequest = crate::parse(&body).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), body);
    let bare: OnceRequest = crate::parse(&json!({"text": "x", "result": "ask", "door": "terminal"})).unwrap();
    assert!(bare.attachments.is_empty());
    assert!(crate::parse::<OnceRequest>(&json!({"text": "  ", "result": "usual", "door": "home"})).is_err());
    let many: Vec<Value> =
        (0..=ONCE_ATTACHMENTS_MAX).map(|n| json!({"kind": "file", "value": n.to_string()})).collect();
    assert!(
        crate::parse::<OnceRequest>(&json!({"text": "x", "attachments": many, "result": "usual", "door": "home"}))
            .is_err()
    );

    let started = OnceStarted {
        routine_id: "rt-1".into(),
        name: "Summary".into(),
        run: StartedRun { id: "rn-1".into(), state: "queued".into(), not_before: None },
    };
    let written = json!({"routineId": "rt-1", "name": "Summary", "run": {"id": "rn-1", "state": "queued"}});
    assert_eq!(serde_json::to_value(&started).unwrap(), written);
}
