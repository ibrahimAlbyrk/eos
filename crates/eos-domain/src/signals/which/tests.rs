use serde_json::{Value, json};

use super::*;

fn rule(value: Value) -> Rule {
    serde_json::from_value(value).expect("a rule")
}

fn facts(value: Value) -> Facts {
    serde_json::from_value(value).expect("facts")
}

fn test(fact: &str, op: &str, operand: Value) -> Value {
    json!({"fact": fact, op: operand})
}

fn passes(op: &str, operand: Value, fact: Value) -> bool {
    let verdict = evaluate(&rule(test("x", op, operand)), &facts(json!({"x": fact})));
    assert_ne!(verdict, Verdict::Missing("x".into()));
    verdict == Verdict::Pass
}

#[test]
fn every_operator_tests_its_kind_of_fact() {
    // is: the same value, of the same kind.
    assert!(passes("is", json!(false), json!(false)));
    assert!(!passes("is", json!(false), json!(true)));
    assert!(passes("is", json!("main"), json!("main")));
    assert!(!passes("is", json!("1"), json!(1)));
    assert!(passes("is", json!(2), json!(2.0)));
    // in: the text, or one of a list's items, is listed.
    assert!(passes("in", json!(["dependabot[bot]", "renovate"]), json!("renovate")));
    assert!(!passes("in", json!(["dependabot[bot]"]), json!("alice")));
    assert!(passes("in", json!(["bug", "p1"]), json!(["docs", "p1"])));
    assert!(!passes("in", json!(["1"]), json!(1)));
    // has: a list holds the item.
    assert!(passes("has", json!("bug"), json!(["bug", "p1"])));
    assert!(!passes("has", json!("bug"), json!(["bugs"])));
    assert!(!passes("has", json!("bug"), json!("bug")));
    // glob: the text, or one of a list's paths.
    assert!(passes("glob", json!("Assets/Scripts/**"), json!(["README.md", "Assets/Scripts/Net/Client.cs"])));
    assert!(!passes("glob", json!("Assets/Scripts/**"), json!(["README.md"])));
    assert!(passes("glob", json!("release/*"), json!("release/2.4")));
    // contains: whatever the case.
    assert!(passes("contains", json!("NETWORK"), json!("Fix the network layer")));
    assert!(passes("contains", json!("istanbul"), json!(["Ankara", "ISTANBUL office"])));
    assert!(!passes("contains", json!("net"), json!(true)));
    // gte, lte: numbers only.
    assert!(passes("gte", json!(10), json!(10)) && passes("gte", json!(10), json!(10.5)));
    assert!(!passes("gte", json!(10), json!(9)) && !passes("gte", json!(10), json!("10")));
    assert!(passes("lte", json!(400), json!(12)) && !passes("lte", json!(400), json!(401)));
}

/// The rule of the plan's example.
fn review_rule() -> Rule {
    rule(json!({"all": [
        {"fact": "draft", "is": false},
        {"fact": "paths", "glob": "Assets/Scripts/**"},
        {"not": {"fact": "author", "in": ["dependabot[bot]"]}},
    ]}))
}

#[test]
fn a_failure_names_its_test_and_a_missing_fact_leaves_it_undecided() {
    let rule = review_rule();
    let pr = |draft: bool, paths: Value, author: &str| {
        evaluate(&rule, &facts(json!({"draft": draft, "paths": paths, "author": author})))
    };
    assert_eq!(pr(false, json!(["Assets/Scripts/Net/Client.cs"]), "alice"), Verdict::Pass);
    assert_eq!(pr(true, json!(["Assets/Scripts/Net/Client.cs"]), "alice"), Verdict::Fail(0));
    assert_eq!(pr(false, json!(["README.md"]), "alice"), Verdict::Fail(1));
    assert_eq!(pr(false, json!(["Assets/Scripts/A.cs"]), "dependabot[bot]"), Verdict::Fail(2));
    // The file list could not be read.
    let unread = facts(json!({"draft": false, "author": "alice"}));
    assert_eq!(evaluate(&rule, &unread), Verdict::Missing("paths".into()));
    // A test that fails decides, whatever is missing.
    let draft = facts(json!({"draft": true, "author": "alice"}));
    assert_eq!(evaluate(&rule, &draft), Verdict::Fail(0));
    let bot = facts(json!({"draft": false, "author": "dependabot[bot]"}));
    assert_eq!(evaluate(&rule, &bot), Verdict::Fail(2));
}

#[test]
fn any_passes_on_one_part_and_fails_on_its_first_failure() {
    let rule = rule(json!({"all": [
        {"fact": "repo", "is": "acme/game"},
        {"any": [{"fact": "labels", "has": "net"}, {"fact": "size", "gte": 500}]},
    ]}));
    let check = |value: Value| evaluate(&rule, &facts(value));
    assert_eq!(check(json!({"repo": "acme/game", "labels": ["net"], "size": 10})), Verdict::Pass);
    assert_eq!(check(json!({"repo": "acme/game", "labels": [], "size": 900})), Verdict::Pass);
    assert_eq!(check(json!({"repo": "acme/game", "labels": [], "size": 10})), Verdict::Fail(1));
    // One part passes: what the other lacks does not matter.
    assert_eq!(check(json!({"repo": "acme/game", "labels": ["net"]})), Verdict::Pass);
    assert_eq!(check(json!({"repo": "acme/game", "size": 900})), Verdict::Pass);
    // No part passes and one lacks its fact: undecided.
    assert_eq!(check(json!({"repo": "acme/game", "labels": []})), Verdict::Missing("size".into()));
    // `not` turns a pass into a failure of its first test, and keeps a missing fact missing.
    let negated = Rule::Not { not: Box::new(rule) };
    assert_eq!(evaluate(&negated, &facts(json!({"repo": "acme/web"}))), Verdict::Pass);
    assert_eq!(evaluate(&negated, &facts(json!({"repo": "acme/game", "size": 900}))), Verdict::Fail(0));
    assert_eq!(evaluate(&negated, &facts(json!({"repo": "acme/game"}))), Verdict::Missing("labels".into()));
}

fn issues(which: Value) -> Vec<String> {
    let which: Which = serde_json::from_value(which).expect("a which");
    let mut cx = Issues::default();
    validate(&which, &mut cx);
    cx.into_vec().iter().map(ToString::to_string).collect()
}

#[test]
fn a_rule_holds_32_tests_three_deep() {
    let tests = |n: usize| json!({"all": vec![json!({"fact": "draft", "is": false}); n]});
    assert!(issues(json!({"rule": tests(32)})).is_empty());
    assert_eq!(issues(json!({"rule": tests(33)})), ["rule: A rule holds at most 32 tests"]);
    assert!(issues(json!({"rule": review_rule()})).is_empty(), "the plan's example is three deep");
    let four = json!({"all": [{"any": [{"not": {"fact": "draft", "is": true}}]}]});
    assert_eq!(issues(json!({"rule": four})), ["rule.all.0.any.0.not: A rule nests at most 3 deep"]);
    assert!(issues(json!({"rule": {"fact": "draft", "is": false}})).is_empty());
}

#[test]
fn every_test_names_a_fact_and_something_to_test() {
    let which = json!({
        "rule": {"any": [
            {"all": []},
            {"fact": "", "is": 1},
            {"fact": "labels", "in": []},
            {"fact": "labels", "has": ""},
            {"fact": "paths", "glob": ""},
            {"fact": "title", "contains": ""},
        ]},
        "ask": "  ",
    });
    assert_eq!(
        issues(which),
        [
            "rule.any.0.all: Array must contain at least 1 element(s)",
            "rule.any.1.fact: String must contain at least 1 character(s)",
            "rule.any.2.in: Array must contain at least 1 element(s)",
            "rule.any.3.has: String must contain at least 1 character(s)",
            "rule.any.4.glob: String must contain at least 1 character(s)",
            "rule.any.5.contains: String must contain at least 1 character(s)",
            "ask: String must contain at least 1 character(s)",
        ]
    );
    assert!(issues(json!({})).is_empty(), "no rule and no question: every item");
    assert!(issues(json!({"ask": "Is this change about networking?"})).is_empty());
}
