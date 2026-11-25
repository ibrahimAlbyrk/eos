use serde_json::{Value, json};

use super::*;

/// A valid team routine: a reader that reads outside text and an editor that
/// leads.
fn pr_review() -> Value {
    json!({
        "format": 1,
        "name": "PR Review",
        "summary": "Reviews each pull request.",
        "icon": "eye",
        "kind": "standing",
        "takes": {"kind": "github.pull_request", "label": "pull request", "placeholder": "#470",
                  "empty": "latest", "many": true},
        "options": [
            {"key": "depth", "label": "Depth", "type": "choice", "values": ["quick", "deep"], "default": "quick",
             "inline": true, "affects": [{"agent": "editor", "model": {"deep": "opus"}}]},
            {"key": "long", "label": "Long", "type": "bool", "default": false, "inline": true},
            {"key": "lang", "label": "Language", "type": "text", "default": "en", "inline": true},
            {"key": "top", "label": "Top", "type": "number", "default": 3, "inline": false},
        ],
        "when": {"on": [{"schedule": {"daily": "05:00", "days": "weekdays", "zone": "Europe/Istanbul"}}]},
        "which": {"ask": "Is this about networking?"},
        "who": {"depth": "team", "agents": [agent("reader", false, true), agent("editor", true, false)],
                "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [{"key": "lines", "text": "Every comment names a line."}], "format": "review",
                "checkAgent": true},
        "makes": {"kind": "github.review", "description": "A pending review."},
        "goesTo": [{"id": "pr", "kind": "item_place", "channel": "github"}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunUsd": 0.05, "perRunMinutes": 240, "perDayUsd": 500, "parallel": 3},
    })
}

fn agent(key: &str, lead: bool, reads_outside: bool) -> Value {
    json!({"key": key, "name": key, "lead": lead, "brief": "Work.", "model": "sonnet", "effort": "medium",
           "tools": {}, "readsOutside": reads_outside, "workspace": "worktree"})
}

fn blueprint(value: &Value) -> Blueprint {
    eos_contracts::read(value).unwrap()
}

/// Eos's data folder in these tests.
const DATA_DIR: &str = "/Users/me/.eos";

/// The issues of `value` as routine `rt-a`, whose fellow routine `rt-b` runs
/// after `rt-a`.
fn issues(value: &Value) -> Vec<(String, String)> {
    let chains = [("rt-b".to_owned(), vec!["rt-a".to_owned()])];
    let context = Context {
        routine: "rt-a",
        chains: &chains,
        known_zone: &|zone| zone == "Europe/Istanbul",
        data_dir: Some(Path::new(DATA_DIR)),
    };
    validate(&blueprint(value), &context)
        .into_iter()
        .map(|issue| {
            assert_eq!(issue.severity, Severity::Error);
            (issue.path.join("."), issue.message)
        })
        .collect()
}

/// The one issue `change` makes in an otherwise valid blueprint.
fn one_issue(change: impl FnOnce(&mut Value)) -> (String, String) {
    let mut value = pr_review();
    change(&mut value);
    let issues = issues(&value);
    assert_eq!(issues.len(), 1, "{issues:?}");
    issues.into_iter().next().unwrap()
}

fn issue(path: &str, message: &str) -> (String, String) {
    (path.to_owned(), message.to_owned())
}

#[test]
fn a_valid_blueprint_has_no_issues() {
    assert_eq!(issues(&pr_review()), Vec::new());
}

#[test]
fn the_format_and_the_name() {
    assert_eq!(one_issue(|v| v["format"] = json!(2)), issue("format", "Expected format 1"));
    assert_eq!(one_issue(|v| v["name"] = json!("  ")), issue("name", "String must contain at least 1 character(s)"));
}

#[test]
fn a_folder_trigger_names_an_absolute_folder_outside_eos_s_data() {
    let folder = |path: &str| json!([{"folder": {"path": path, "events": ["added"]}}]);
    for fine in ["/Users/me/Downloads", "/Users/me/.eos-old", "/Users/me", "/Users/me/.eos/../Downloads"] {
        let mut value = pr_review();
        value["when"]["on"] = folder(fine);
        assert_eq!(issues(&value), Vec::new(), "{fine}");
    }
    let at = "when.on.0.folder.path";
    for relative in ["~/Downloads", "Downloads", "./in"] {
        assert_eq!(one_issue(|v| v["when"]["on"] = folder(relative)), issue(at, "Expected an absolute path"));
    }
    for inside in [
        DATA_DIR,
        "/Users/me/.eos/",
        "/Users/me/.eos/pages",
        "/Users/me/x/../.eos/pages",
        "/Users/me/./.eos",
        "/users/me/.EOS/pages",
        "/../Users/me/.eos",
    ] {
        assert_eq!(
            one_issue(|v| v["when"]["on"] = folder(inside)),
            issue(at, "Must not be inside Eos's data folder"),
            "{inside}"
        );
    }

    // Without the data folder known, the folder source refuses it at run time.
    let mut value = pr_review();
    value["when"]["on"] = folder("/Users/me/.eos/pages");
    let context = Context { routine: "rt-a", chains: &[], known_zone: &|_| true, data_dir: None };
    assert!(validate(&blueprint(&value), &context).is_empty());
}

#[test]
fn at_most_three_options_show_inline() {
    assert_eq!(
        one_issue(|v| v["options"][3]["inline"] = json!(true)),
        issue("options", "At most 3 options show inline")
    );
}

#[test]
fn option_keys_are_unique() {
    assert_eq!(
        one_issue(|v| v["options"][2]["key"] = json!("depth")),
        issue("options.2.key", "An earlier entry has the same one")
    );
}

#[test]
fn a_default_is_a_value_of_its_option() {
    assert_eq!(
        one_issue(|v| v["options"][0]["default"] = json!("slow")),
        issue("options.0.default", "Expected one of the values")
    );
    assert_eq!(
        one_issue(|v| v["options"][0]["values"] = json!([])),
        issue("options.0.values", "A choice needs values")
    );
    assert_eq!(
        one_issue(|v| v["options"][1]["default"] = json!("yes")),
        issue("options.1.default", "Expected a boolean")
    );
    assert_eq!(one_issue(|v| v["options"][2]["default"] = json!(1)), issue("options.2.default", "Expected a text"));
    assert_eq!(one_issue(|v| v["options"][3]["default"] = json!("3")), issue("options.3.default", "Expected a number"));
}

#[test]
fn an_option_affects_only_agents_of_the_routine() {
    assert_eq!(
        one_issue(|v| v["options"][0]["affects"][0]["agent"] = json!("writer")),
        issue("options.0.affects.0.agent", "Names no agent of the routine")
    );
}

#[test]
fn the_when_and_which_owners_check_their_slots() {
    assert_eq!(
        one_issue(|v| v["when"]["on"][0]["schedule"]["zone"] = json!("Mars/Olympus")),
        issue("when.on.0.schedule.zone", "Unknown time zone")
    );
    assert_eq!(
        one_issue(|v| v["when"]["limits"] = json!({"perHour": 0})),
        issue("when.limits.perHour", "Number must be greater than or equal to 1")
    );
    assert_eq!(
        one_issue(|v| v["which"]["ask"] = json!(" ")),
        issue("which.ask", "String must contain at least 1 character(s)")
    );
}

#[test]
fn an_after_trigger_may_not_close_a_loop() {
    let looped = "Makes a loop: this routine would run after itself";
    let after = |routine: &str| json!({"after": {"routine": routine, "outcome": "done"}});
    assert_eq!(
        one_issue(|v| v["when"]["on"] = json!([after("rt-c"), after("rt-b")])),
        issue("when.on.1.after.routine", looped)
    );
    assert_eq!(one_issue(|v| v["when"]["on"] = json!([after("rt-a")])), issue("when.on.0.after.routine", looped));
    let mut free = pr_review();
    free["when"]["on"] = json!([after("rt-c")]);
    assert_eq!(issues(&free), Vec::new(), "rt-c runs after nothing");

    // Two other routines already loop (a sync can bring that): the loop
    // through this one is still found.
    let mut value = pr_review();
    value["when"]["on"] = json!([after("rt-x"), after("rt-b")]);
    let chains = [
        ("rt-x".to_owned(), vec!["rt-y".to_owned()]),
        ("rt-y".to_owned(), vec!["rt-x".to_owned()]),
        ("rt-b".to_owned(), vec!["rt-a".to_owned()]),
    ];
    let context = Context { routine: "rt-a", chains: &chains, known_zone: &|_| true, data_dir: None };
    let found: Vec<_> = validate(&blueprint(&value), &context).into_iter().map(|issue| issue.path.join(".")).collect();
    assert_eq!(found, ["when.on.1.after.routine"]);
}

#[test]
fn grant_and_bound_rules_meet_the_bounds_of_which() {
    let empty = "Array must contain at least 1 element(s)";
    assert_eq!(
        one_issue(|v| v["freedom"]["grants"] = json!([{"id": "g", "when": {"all": []}, "rung": "on_its_own"}])),
        issue("freedom.grants.0.when.all", empty)
    );
    assert_eq!(
        one_issue(|v| v["goesTo"][0]["bound"] = json!({"fact": "repo", "in": []})),
        issue("goesTo.0.bound.in", empty)
    );
    let deep = json!({"not": {"not": {"not": {"fact": "draft", "is": true}}}});
    assert_eq!(
        one_issue(|v| v["freedom"]["grants"] = json!([{"id": "g", "when": deep, "rung": "draft"}])),
        issue("freedom.grants.0.when.not.not.not", "A rule nests at most 3 deep")
    );
}

#[test]
fn a_solo_routine_has_one_agent() {
    assert_eq!(
        one_issue(|v| v["who"]["depth"] = json!("solo")),
        issue("who.agents", "A solo routine has exactly one agent")
    );
    let mut solo = pr_review();
    solo["who"]["depth"] = json!("solo");
    solo["who"]["agents"] = json!([agent("reader", false, true)]);
    solo["options"][0]["affects"] = json!([]);
    assert_eq!(issues(&solo), Vec::new());
}

#[test]
fn a_team_has_one_lead() {
    let no_lead = issue("who.agents", "A team has exactly one lead");
    assert_eq!(one_issue(|v| v["who"]["agents"][1]["lead"] = json!(false)), no_lead);
    let two_leads = |v: &mut Value| v["who"]["agents"][0] = agent("reader", true, false);
    assert_eq!(one_issue(two_leads), no_lead);
}

#[test]
fn a_script_routine_has_a_script_and_no_agents() {
    let mut script = pr_review();
    script["who"]["depth"] = json!("script");
    script["options"][0]["affects"] = json!([]);
    assert_eq!(
        issues(&script),
        vec![
            issue("who.script", "A script routine needs its script"),
            issue("who.agents", "A script routine has no agents"),
        ]
    );
    script["who"]["agents"] = json!([]);
    script["who"]["script"] = json!({"source": "export default async () => 1;",
                                     "hash": "3dc301f2fe3f085ec7a9904e0024dc562beed4ea08f30d6212d3cafb355b18c3"});
    assert_eq!(issues(&script), Vec::new());
    script["who"]["script"]["hash"] = json!("ab");
    assert_eq!(issues(&script), vec![issue("who.script.hash", "Is not the SHA-256 of the source")]);
}

#[test]
fn an_agent_that_reads_outside_text_leads_no_team_of_more_than_one() {
    assert_eq!(
        one_issue(|v| v["who"]["agents"][1]["readsOutside"] = json!(true)),
        issue("who.agents.1.lead", "An agent that reads outside text cannot lead a team")
    );
    let mut alone = pr_review();
    alone["who"]["agents"] = json!([agent("editor", true, true)]);
    assert_eq!(issues(&alone), Vec::new());
}

#[test]
fn agent_check_and_recipient_keys_are_unique() {
    let again = "An earlier entry has the same one";
    assert_eq!(one_issue(|v| v["who"]["agents"][0]["key"] = json!("editor")), issue("who.agents.1.key", again));
    assert_eq!(
        one_issue(|v| v["how"]["checks"] = json!([{"key": "a", "text": "x"}, {"key": "a", "text": "y"}])),
        issue("how.checks.1.key", again)
    );
    assert_eq!(
        one_issue(|v| v["goesTo"].as_array_mut().unwrap().push(json!({"id": "pr", "kind": "me", "channel": "notify"}))),
        issue("goesTo.1.id", again)
    );
}

#[test]
fn limits_stay_within_their_ranges() {
    let cases = [
        ("perRunUsd", json!(0.04), "Number must be greater than or equal to 0.05"),
        ("perRunUsd", json!(100.01), "Number must be less than or equal to 100"),
        ("perRunMinutes", json!(0), "Number must be greater than or equal to 1"),
        ("perRunMinutes", json!(241), "Number must be less than or equal to 240"),
        ("perDayUsd", json!(0.49), "Number must be greater than or equal to 0.5"),
        ("perDayUsd", json!(500.5), "Number must be less than or equal to 500"),
        ("parallel", json!(0), "Number must be greater than or equal to 1"),
        ("parallel", json!(4), "Number must be less than or equal to 3"),
    ];
    for (field, value, message) in cases {
        assert_eq!(one_issue(|v| v["limits"][field] = value), issue(&format!("limits.{field}"), message));
    }
}

#[test]
fn a_project_has_its_slot_and_no_per_run_cap() {
    let mut project = pr_review();
    project["kind"] = json!("project");
    project["limits"] = json!({"perRunUsd": 1000, "perRunMinutes": 10_000, "perDayUsd": 20, "parallel": 1});
    assert_eq!(issues(&project), vec![issue("project", "A project routine needs its project")]);

    project["project"] = json!({"repo": "/Users/me/game", "baseBranch": "main", "brief": "Build it.",
                                "milestones": [{"key": "a", "title": "A", "doneWhen": "Done."}]});
    assert_eq!(issues(&project), Vec::new());
    project["project"]["milestones"] = json!([]);
    assert_eq!(issues(&project), vec![issue("project.milestones", "Array must contain at least 1 element(s)")]);
    project["project"]["milestones"] =
        json!([{"key": "a", "title": "A", "doneWhen": "x"}, {"key": "a", "title": "B", "doneWhen": "y"}]);
    assert_eq!(issues(&project), vec![issue("project.milestones.1.key", "An earlier entry has the same one")]);

    let mut reads_one = pr_review();
    reads_one["project"] = json!({"repo": "git:github.com/me/game", "baseBranch": "", "brief": ""});
    assert_eq!(issues(&reads_one), Vec::new(), "another kind names a project for its repository alone");
}

#[test]
fn canonical_json_keeps_unknown_keys_inside_the_slots_it_embeds() {
    let mut value = pr_review();
    value["when"]["quiet"] = json!(true);
    value["when"]["on"][0]["schedule"]["skip"] = json!("holidays");
    value["which"]["rule"] = json!({"fact": "draft", "is": false, "label": "ready"});
    value["freedom"]["later"] = json!(1);
    value["goesTo"][0]["replyAll"] = json!(false);
    let canonical = canonical_json(&blueprint(&value));
    for kept in [
        r#""when":{"on":[{"schedule":{"daily":"05:00","days":"weekdays","skip":"holidays","zone":"Europe/Istanbul"}}],"limits":{"perHour":30,"queued":25},"quiet":true}"#,
        r#""which":{"rule":{"fact":"draft","is":false,"label":"ready"},"ask":"Is this about networking?"}"#,
        r#""goesTo":[{"id":"pr","kind":"item_place","channel":"github","replyAll":false}]"#,
        r#""freedom":{"rung":"draft","grants":[],"later":1}"#,
    ] {
        assert!(canonical.contains(kept), "{kept} in {canonical}");
    }
    let again = canonical_json(&blueprint(&serde_json::from_str(&canonical).unwrap()));
    assert_eq!(hash(&again), hash(&canonical));
}

#[test]
fn a_known_format_reads_as_a_blueprint_that_runs() {
    let read = read(&pr_review()).unwrap();
    assert!(read.runnable());
    assert_eq!(read, Readable::Current(Box::new(blueprint(&pr_review()))));
    assert_eq!(upgrade(pr_review(), 1), pr_review(), "format 1 is this app's: nothing to upgrade");
}

#[test]
fn a_newer_format_is_read_as_it_came_but_never_runs() {
    let newer = json!({"format": 2, "name": "From a newer Eos", "who": {"crew": ["a", "b"]}});
    let read = read(&newer).unwrap();
    assert!(!read.runnable());
    assert_eq!(read, Readable::Newer { format: 2, blueprint: newer });
}

#[test]
fn a_blueprint_without_a_format_or_with_a_bad_slot_is_refused() {
    for format in [json!(null), json!(0), json!("1"), json!(1.5)] {
        let mut value = pr_review();
        value["format"] = format;
        assert_eq!(
            read(&value).unwrap_err().message(),
            "invalid request: format: Expected a whole number of at least 1"
        );
    }
    let mut value = pr_review();
    value["freedom"]["rung"] = json!("always");
    assert_eq!(
        read(&value).unwrap_err().message(),
        "invalid request: freedom.rung: Invalid enum value. Expected 'ask' | 'draft' | 'send_then_tell' | 'on_its_own', received 'always'"
    );
    let mut value = pr_review();
    value["goesTo"][0]["kind"] = json!("anyone");
    assert!(read(&value).unwrap_err().message().starts_with("invalid request: goesTo.0"));
}
