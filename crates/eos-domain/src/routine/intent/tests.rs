use std::time::{Duration, Instant};

use serde_json::Value;

use super::*;

const PULL: &str = r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)";
const NUMBER: &str = r"(?:^|\s)#(\d+)\b";

fn routines() -> Vec<Known> {
    vec![
        Known::new("rt-pr", "PR Review", "pr-review", &["review".into()], &[PULL.into(), NUMBER.into()]),
        Known::new("rt-mail", "Mail Triage", "mail-triage", &["triage".into(), "inbox".into()], &[]),
        Known::new("rt-inv", "Invoice Filer", "invoice-filer", &["file invoice".into()], &[r"\S+\.pdf\b".into()]),
    ]
}

fn reading(text: &str) -> Reading {
    read(&Asked { text, ..Asked::default() }, &routines())
}

fn verdict(text: &str) -> (IntentKind, bool, Option<String>) {
    let reading = reading(text);
    (reading.intent, reading.certain, reading.routine_id)
}

fn sure(intent: IntentKind, routine: Option<&str>) -> (IntentKind, bool, Option<String>) {
    (intent, true, routine.map(str::to_owned))
}

#[test]
fn a_named_routine_with_an_item_it_takes_runs_on_it() {
    let mut cases = 0;
    for n in 1..=20 {
        for name in ["review", "PR Review", "pr-review", "Review", "please review"] {
            let text = format!("{name} #{n}");
            assert_eq!(verdict(&text), sure(IntentKind::Run, Some("rt-pr")), "{text}");
            assert_eq!(reading(&text).item.as_deref(), Some(format!("#{n}").as_str()), "{text}");
            cases += 1;
        }
    }
    let link = "https://github.com/acme/game/pull/470";
    assert_eq!(reading(link).line, format!("Run PR Review on {link}"));
    assert_eq!(reading("review #470").line, "Run PR Review on #470");
    assert_eq!(cases, 100);
}

#[test]
fn an_item_one_routine_recognises_runs_it_and_a_bare_name_runs_on_the_latest() {
    for text in ["#12", "look at #12", "https://github.com/a/b/pull/3", "~/Downloads/acme.pdf", "file this: x.pdf"] {
        let expect = if text.contains("pdf") { "rt-inv" } else { "rt-pr" };
        assert_eq!(verdict(text), sure(IntentKind::Run, Some(expect)), "{text}");
    }
    for (text, id) in [("PR Review", "rt-pr"), ("mail-triage", "rt-mail"), ("Triage", "rt-mail"), ("inbox.", "rt-mail")]
    {
        assert_eq!(verdict(text), sure(IntentKind::Run, Some(id)), "{text}");
        assert!(reading(text).line.ends_with("on the latest"), "{text}");
    }
}

#[test]
fn repetition_and_condition_words_make_a_routine() {
    let texts = [
        "every morning summarise my calendar",
        "Every Monday send the sprint report",
        "whenever a release is tagged write notes",
        "each morning list my meetings",
        "each evening back up my notes",
        "each day check the build",
        "each week send me the open bugs",
        "each month total my invoices",
        "daily check the uptime page",
        "weekly digest of my starred repos",
        "monthly report of spending",
        "nightly run the long tests",
        "hourly look at the queue",
        "each time a deploy fails tell me",
        "any time someone mentions me, summarise it",
        "when a customer writes, draft a reply",
        "when an invoice arrives, file it",
        "if a build fails, open an issue",
        "if an alert fires, page me",
        "on mondays plan the week",
        "on friday tidy my downloads",
        "on Tuesdays water the plants reminder",
        "weekdays at 9 read the news",
        "check the build at 5",
        "check the build at 5pm",
        "send the summary by 18:00",
        "at 7:30 am brief me",
        "thursdays post the changelog",
        "saturdays clean the inbox folder of spam reports",
        "sundays plan meals",
    ];
    for text in texts {
        assert_eq!(verdict(text), sure(IntentKind::Make, None), "{text}");
        assert_eq!(reading(text).line, MAKE_LINE);
    }
}

#[test]
fn a_named_routine_with_change_words_changes_it() {
    let words = [
        "should also check shaders",
        "should not comment on drafts",
        "stop labelling",
        "never archive",
        "change its tone",
        "no longer post",
        "don't send",
        "instead write a summary",
    ];
    for (name, id) in [("PR Review", "rt-pr"), ("Mail Triage", "rt-mail"), ("Invoice Filer", "rt-inv")] {
        for words in words {
            let text = format!("{name} {words}");
            assert_eq!(verdict(&text), sure(IntentKind::Change, Some(id)), "{text}");
            assert_eq!(reading(&text).line, format!("Change {name}"));
        }
    }
}

#[test]
fn anything_else_is_not_certain_and_offers_choices() {
    let texts = [
        "summarise this article",
        "what's the weather",
        "write a haiku",
        "translate this paragraph",
        "fix the flaky test",
        "plan my trip to Lisbon",
        "draft a reply to Sam",
        "how much did I spend",
        "clean up the repo",
        "rename the branch",
        "",
        "   ",
        "hello",
        "do the thing",
        "make it nicer",
        "find the bug in auth",
        "book a table",
        "explain this error",
        "count the lines of code",
        "open the release notes",
    ];
    for text in texts {
        let reading = reading(text);
        assert_eq!((reading.intent, reading.certain), (IntentKind::Unsure, false), "{text}");
        let choices: Vec<IntentKind> = reading.alternatives.iter().map(|choice| choice.intent).collect();
        assert_eq!(choices, [IntentKind::Make, IntentKind::Once], "{text}");
    }
    // Two routines take the item: a run of each, then making one.
    let both = vec![
        Known::new("rt-a", "Alpha", "alpha", &[], &[NUMBER.into()]),
        Known::new("rt-b", "Beta", "beta", &[], &[NUMBER.into()]),
        Known::new("rt-c", "Gamma", "gamma", &[], &[NUMBER.into()]),
    ];
    let reading = read(&Asked { text: "#4", ..Asked::default() }, &both);
    assert!(!reading.certain);
    let ids: Vec<Option<&str>> = reading.alternatives.iter().map(|choice| choice.routine_id.as_deref()).collect();
    assert_eq!(ids, [Some("rt-a"), Some("rt-b"), Some("rt-c")], "at most three");
}

#[test]
fn a_forced_mode_or_a_picked_routine_decides() {
    let forced = |forced, routine_id, text| {
        let asked = Asked { text, forced: Some(forced), routine_id, ..Asked::default() };
        let reading = read(&asked, &routines());
        (reading.intent, reading.certain, reading.routine_id)
    };
    assert_eq!(forced(IntentKind::Once, None, "review #4"), sure(IntentKind::Once, None));
    assert_eq!(forced(IntentKind::Make, None, "hello"), sure(IntentKind::Make, None));
    assert_eq!(forced(IntentKind::Run, Some("rt-mail"), "#4"), sure(IntentKind::Run, Some("rt-mail")));
    assert_eq!(forced(IntentKind::Change, None, "PR Review tone"), sure(IntentKind::Change, Some("rt-pr")));
    let picked = |text| {
        let reading = read(&Asked { text, routine_id: Some("rt-pr"), ..Asked::default() }, &routines());
        (reading.intent, reading.item)
    };
    assert_eq!(picked("#470"), (IntentKind::Run, Some("#470".to_owned())));
    assert_eq!(picked(""), (IntentKind::Run, None));
    assert_eq!(picked("should also check shaders"), (IntentKind::Change, None));
    let values = ["https://github.com/a/b/pull/9".to_owned()];
    let reading = read(&Asked { text: "", attachments: &values, ..Asked::default() }, &routines());
    assert_eq!((reading.intent, reading.routine_id.as_deref()), (IntentKind::Run, Some("rt-pr")), "a dropped link");
}

/// The routines of a vector as the rules read them.
fn vector_routines(vector: &Value) -> Vec<Known> {
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    vector["routines"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|r| {
                    Known::new(
                        &text(&r["id"]),
                        &text(&r["name"]),
                        &text(&r["slug"]),
                        &strings(&r["aliases"]),
                        &strings(&r["itemPatterns"]),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn the_shared_vectors_are_decided_as_written() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/routines/intent-vectors.json");
    let vectors: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).expect("the vectors")).expect("JSON");
    assert!(vectors.len() >= 20);
    for vector in &vectors {
        let text = vector["text"].as_str().unwrap_or_default();
        let reading = read(&Asked { text, ..Asked::default() }, &vector_routines(vector));
        let intent: IntentKind = serde_json::from_value(vector["expect"]["intent"].clone()).expect("an intent");
        assert_eq!(reading.intent, intent, "{text}");
        assert!(reading.certain, "only clear cases: {text}");
        assert_eq!(reading.routine_id.as_deref(), vector["expect"]["routineId"].as_str(), "{text}");
        for pattern in vector["routines"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|r| r["itemPatterns"].as_array().into_iter().flatten())
        {
            assert!(Regex::new(pattern.as_str().unwrap_or_default()).is_ok(), "a JavaScript pattern: {pattern}");
        }
    }
}

#[test]
fn the_rules_read_a_sentence_against_a_hundred_routines_within_twenty_milliseconds() {
    let names: Vec<(String, String)> = (0..100).map(|n| (format!("Routine {n}"), format!("routine-{n}"))).collect();
    let mut times = Vec::new();
    for text in ["every morning summarise", "routine-42 #7", "write a haiku", "Routine 99 should also stop", "#12"] {
        for _ in 0..20 {
            let started = Instant::now();
            let known: Vec<Known> = names
                .iter()
                .map(|(name, slug)| {
                    Known::new(slug, name, slug, &[format!("alias {slug}")], &[NUMBER.into(), PULL.into()])
                })
                .collect();
            let _ = read(&Asked { text, ..Asked::default() }, &known);
            times.push(started.elapsed());
        }
    }
    times.sort();
    let p95 = times[times.len() * 95 / 100];
    assert!(p95 <= Duration::from_millis(20), "p95 {p95:?}");
}
