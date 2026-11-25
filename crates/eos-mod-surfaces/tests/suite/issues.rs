//! A routine's View surface follows the routine, and a run hands its View
//! back as an issue of it: checked as `present` checks it, every send bound
//! to an action the routine may run, nothing prefilled, the bindings'
//! templates kept from the frame.

use eos_core::Error;
use eos_core::surface::{ReturnedView, SurfaceAuthoring};
use eos_mod_surfaces::SurfaceAuthor;
use eos_runtime::http::Method;
use eos_surface::{Level, Place, VersionStatus};
use serde_json::{Value, json};

use crate::rig::{Rig, surface, version};

fn author(rig: &Rig) -> SurfaceAuthor {
    rig.author()
}

fn digest(bindings: Value) -> ReturnedView {
    ReturnedView {
        place: "result".into(),
        view: json!({"title": "Overnight", "summary": "Three mails came in.", "ui": "<Callout action=\"again\">Three mails</Callout>",
                     "data": {"lead": {"url": "https://example.com/a"}},
                     "actions": {"again": {"label": "Run again", "kind": "send", "text": "again"}}}),
        bindings: Some(bindings),
        facts: None,
        aside: None,
    }
}

/// The decision card: a choice of two ways, with a Form that sends it.
fn decision(facts: Value, aside: Value) -> ReturnedView {
    ReturnedView {
        place: "question".into(),
        view: json!({"title": "Mail Triage needs an answer", "summary": "How it should reach you by SMS.",
                     "ui": "<Form action=\"confirm\"><Choice bind=\"way\" question=\"How should Eos reach you by SMS?\" options=\"Through your iPhone | An SMS provider\"/></Form>",
                     "actions": {"confirm": {"label": "Confirm", "kind": "send", "text": "confirm"}}}),
        bindings: Some(json!({"confirm": {"action": "probe.again"}})),
        facts: Some(facts),
        aside: Some(aside),
    }
}

fn refused(result: Result<String, Error>) -> String {
    match result {
        Err(Error::Validation(text)) => text,
        other => panic!("refused: {other:?}"),
    }
}

#[tokio::test]
async fn a_routines_surface_is_made_kept_archived_and_restored_with_it() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Morning mail", "rn-1", "standing", "w-lead");
    let author = author(&rig);
    author.create_for_routine("rt-1", "rv-1", "view").await.expect("made");
    author.create_for_routine("rt-1", "rv-1", "view").await.expect("once");
    author.create_for_routine("rt-1", "rv-1", "github.review").await.expect("not a surface");
    let (_, list) = rig.ask(Method::Get, "/api/surfaces?routine=rt-1", None).await;
    let surfaces = list["surfaces"].as_array().expect("a list").clone();
    assert_eq!(surfaces.len(), 1);
    assert_eq!(
        (surfaces[0]["level"].as_str(), surfaces[0]["place"].as_str(), surfaces[0]["title"].as_str()),
        (Some("view"), Some("needs_you"), Some("Morning mail"))
    );

    author.archive_for_routine("rt-1").await.expect("archived");
    assert_eq!(rig.ask(Method::Get, "/api/surfaces?routine=rt-1", None).await.1["surfaces"], json!([]));
    author.restore_for_routine("rt-1").await.expect("restored");
    assert_eq!(
        rig.ask(Method::Get, "/api/surfaces?routine=rt-1", None).await.1["surfaces"].as_array().map(Vec::len),
        Some(1)
    );
    let whats: Vec<String> = rig
        .temp
        .announced
        .list()
        .into_iter()
        .filter(|(topic, _)| *topic == "surfaces:change")
        .map(|(_, payload)| {
            serde_json::from_str::<Value>(&payload).expect("json")["what"].as_str().unwrap_or_default().to_owned()
        })
        .collect();
    assert_eq!(whats, ["created", "archived", "restored"]);

    let mut page = surface("sf-p", "rt-2", Level::Page, Place::RoutinePage, 1);
    page.candidate_version = Some(1);
    rig.seed(vec![page], vec![version("sf-p", 1, VersionStatus::Candidate)], vec![]).await;
    author.keep("rt-2").await.expect("kept");
    let (_, kept) = rig.ask(Method::Get, "/api/surfaces/sf-p", None).await;
    assert_eq!((kept["currentVersion"].as_i64(), kept.get("candidateVersion")), (Some(1), None));
    assert_eq!(rig.ask(Method::Get, "/api/surfaces/sf-p/versions/1", None).await.1["meta"]["status"], "kept");
}

#[tokio::test]
async fn a_run_returns_its_view_as_an_issue_whose_templates_stay_in_the_core() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Morning mail", "rn-1", "standing", "w-lead");
    author(&rig).create_for_routine("rt-1", "rv-1", "view").await.expect("made");
    let tools = rig.module.tools();
    let bound = json!({"again": {"action": "probe.with", "args": {"item": "{data.lead.url}"}}});
    let line = tools.return_view("w-lead", digest(bound)).await.expect("stored");
    assert!(line.starts_with("issue si-") && line.ends_with("· 1 bound action"), "{line}");
    let issue_id = line.split_whitespace().nth(1).expect("an id").to_owned();
    assert!(rig.temp.announced.topics().contains(&"surfaces:issue"));

    let (_, list) = rig.ask(Method::Get, "/api/surfaces?routine=rt-1", None).await;
    let surface_id = list["surfaces"][0]["id"].as_str().expect("a surface").to_owned();
    let (status, issues) = rig.ask(Method::Get, &format!("/api/surfaces/{surface_id}/issues"), None).await;
    assert_eq!(status, 200);
    assert_eq!((issues["issues"][0]["seq"].as_i64(), issues["more"].as_bool()), (Some(1), Some(false)));
    let (_, one) = rig.ask(Method::Get, &format!("/api/surfaces/{surface_id}/issues/{issue_id}"), None).await;
    assert_eq!(one["body"]["actions"], json!(["again"]));
    assert_eq!(one["body"]["view"]["title"], "Overnight");
    assert!(one["body"].get("bindings").is_none(), "the frame never sees an argument template");
    // An `eos://issue/<id>` link names no surface: the issue is found by its id alone.
    let (status, found) = rig.ask(Method::Get, &format!("/api/surface-issues/{issue_id}"), None).await;
    assert_eq!(status, 200);
    assert_eq!((found["surfaceId"].as_str(), found["seq"].as_i64()), (Some(surface_id.as_str()), Some(1)));
    let (status, _) = rig.ask(Method::Get, "/api/surface-issues/si-missing", None).await;
    assert_eq!(status, 404);

    let pressed = json!({"issueId": issue_id, "actionId": "again", "clientId": "c-1"});
    let (_, answer) = rig.ask(Method::Post, "/api/actions/run", Some(pressed)).await;
    assert_eq!(answer["result"], json!({"echo": {"item": "https://example.com/a"}}));
}

#[tokio::test]
async fn a_view_that_is_not_one_or_binds_what_it_may_not_is_refused_with_every_problem() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Morning mail", "rn-1", "trial", "w-lead");
    author(&rig).create_for_routine("rt-1", "rv-1", "view").await.expect("made");
    let tools = rig.module.tools();
    let problems = |result: Result<String, Error>| match result {
        Err(Error::Validation(text)) => text,
        other => panic!("refused: {other:?}"),
    };
    let unbound = problems(tools.return_view("w-lead", digest(json!({}))).await);
    assert!(unbound.contains("view.actions.again: is a send with no entry in bindings"), "{unbound}");
    let foreign =
        problems(tools.return_view("w-lead", digest(json!({"again": {"action": "mail.send_to_anyone"}}))).await);
    assert!(foreign.contains("mail.send_to_anyone is not an action this routine may run"), "{foreign}");
    let mut broken = digest(json!({}));
    broken.view = json!({"title": "No ui"});
    broken.place = "aside".into();
    let broken = problems(tools.return_view("w-lead", broken).await);
    assert!(broken.contains("place: must be result or question") && broken.contains("view."), "{broken}");
    let mut prefill = digest(json!({"again": {"action": "probe.again"}}));
    prefill.view["actions"]["fill"] = json!({"label": "Fill", "kind": "prefill", "text": "x"});
    assert!(problems(tools.return_view("w-lead", prefill).await).contains("prefill has no chat"));

    let elsewhere = tools.return_view("w-chat", digest(json!({"again": {"action": "probe.again"}}))).await;
    assert!(problems(elsewhere).contains("return_view is for a routine run's sessions"));
    rig.run_worker("rt-2", "Reviews", "rn-2", "standing", "w-other");
    let no_view = tools.return_view("w-other", digest(json!({"again": {"action": "probe.again"}}))).await;
    assert!(problems(no_view).contains("this routine makes no view"));

    let line = tools.return_view("w-lead", digest(json!({"again": {"action": "probe.again"}}))).await.expect("stored");
    let issue_id = line.split_whitespace().nth(1).expect("an id").to_owned();
    let stored =
        rig.temp.port().read(move |tx| tx.surface_issues().find(&issue_id)).await.expect("reads").expect("an issue");
    assert!(stored.trial && stored.seq.is_none(), "a trial's issue has no number");
}

#[tokio::test]
async fn a_returned_view_waits_in_needs_you_and_a_question_hands_its_run_the_answer() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Morning mail", "rn-1", "standing", "w-lead");
    author(&rig).create_for_routine("rt-1", "rv-1", "view").await.expect("made");
    let tools = rig.module.tools();
    let bound = || json!({"again": {"action": "probe.with", "args": {"item": "{data.lead.url}"}}});
    let line = tools.return_view("w-lead", digest(bound())).await.expect("stored");
    assert!(line.ends_with("· 1 bound action"), "a result View does not wait: {line}");
    let card = &rig.cards.opened()[0];
    assert_eq!(
        (card.question, card.title.as_str(), card.summary.as_str()),
        (false, "Overnight", "Three mails came in.")
    );
    assert_eq!((card.routine_id.as_str(), card.run_id.as_str()), ("rt-1", "rn-1"));
    assert!(line.contains(&card.issue_id), "the card names its issue");

    let asked = ReturnedView { place: "question".into(), ..digest(bound()) };
    let line = tools.return_view("w-lead", asked).await.expect("answered");
    assert!(line.ends_with("The user answered: Ship it"), "the run hears the answer: {line}");
    let question = rig.cards.opened()[1].clone();
    assert!(question.question);
    let pressed = json!({"issueId": question.issue_id, "actionId": "again", "clientId": "c-q",
                         "state": {"note": "today"}});
    let (_, answer) = rig.ask(Method::Post, "/api/actions/run", Some(pressed)).await;
    assert_eq!(answer["status"], "done");
    assert_eq!(rig.cards.answered(), [("ny-view-2".to_owned(), "Run again (note: today)".to_owned())]);
    let first = json!({"issueId": card.issue_id, "actionId": "again", "clientId": "c-r"});
    rig.ask(Method::Post, "/api/actions/run", Some(first)).await;
    assert_eq!(rig.cards.answered().len(), 1, "a press on a result View answers nothing");

    rig.run_worker("rt-1", "Morning mail", "rn-2", "trial", "w-trial");
    tools.return_view("w-trial", digest(bound())).await.expect("stored");
    assert_eq!(rig.cards.opened().len(), 2, "a trial's View waits nowhere");
}

#[tokio::test]
async fn a_view_keeps_the_facts_of_its_options_and_its_notes_marked_as_outside_text() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Mail Triage", "rn-1", "trial", "w-lead");
    author(&rig).create_for_routine("rt-1", "rv-1", "view").await.expect("made");
    let facts = json!([
        {"option": "Through your iPhone", "rows": [{"label": "Cost", "value": "Free"}, {"label": "Setup", "value": "None"},
                                                  {"label": "Works", "value": "While this Mac is on"}]},
        {"option": "An SMS provider", "rows": [{"label": "Cost", "value": " Per message "}]},
    ]);
    let aside =
        json!([{"title": "Why Eos is asking", "text": "Mail Triage sorts your mail but has no way to reach you."}]);
    let line = rig.module.tools().return_view("w-lead", decision(facts, aside)).await.expect("stored");
    let issue_id = line.split_whitespace().nth(1).expect("an id").to_owned();
    let (_, list) = rig.ask(Method::Get, "/api/surfaces?routine=rt-1", None).await;
    let surface_id = list["surfaces"][0]["id"].as_str().expect("a surface").to_owned();
    let (_, one) = rig.ask(Method::Get, &format!("/api/surfaces/{surface_id}/issues/{issue_id}"), None).await;
    let body = &one["body"];
    assert_eq!(
        body["facts"][1],
        json!({"option": "An SMS provider", "rows": [{"label": "Cost", "value": "Per message"}]})
    );
    assert_eq!(body["facts"][0]["rows"].as_array().map(Vec::len), Some(3));
    assert_eq!(body["aside"][0]["title"], "Why Eos is asking");
    // The rig's run has no kept version behind it: it is held to have read outside text.
    assert_eq!(body["untrusted"], true);
    let keys: Vec<&String> = body.as_object().expect("a body").keys().collect();
    assert_eq!(keys, ["place", "view", "actions", "facts", "aside", "untrusted"]);

    // A run of a version the user kept, on nothing from outside, is not marked; a View
    // without facts or notes answers neither.
    rig.temp.exec(
        "INSERT INTO routine_versions (id, routine_id, status, author, format, blueprint, hash, created_at) \
         VALUES ('rv-1', 'rt-1', 'kept', 'user', 1, '{}', 'h', 1); \
         UPDATE runs SET input = '{\"result\": \"usual\"}' WHERE id = 'rn-1';",
    );
    let plain = ReturnedView { facts: None, aside: None, ..decision(json!([]), json!([])) };
    let line = rig.module.tools().return_view("w-lead", plain).await.expect("stored");
    let issue_id = line.split_whitespace().nth(1).expect("an id").to_owned();
    let (_, one) = rig.ask(Method::Get, &format!("/api/surfaces/{surface_id}/issues/{issue_id}"), None).await;
    let keys: Vec<&String> = one["body"].as_object().expect("a body").keys().collect();
    assert_eq!(keys, ["place", "view", "actions"]);
}

#[tokio::test]
async fn facts_and_notes_past_their_bounds_or_on_no_option_are_refused_with_every_problem() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Mail Triage", "rn-1", "trial", "w-lead");
    author(&rig).create_for_routine("rt-1", "rv-1", "view").await.expect("made");
    let tools = rig.module.tools();
    let row = json!({"label": "Cost", "value": "Free"});
    let facts = json!([
        {"option": "By pigeon", "rows": [row]},
        {"option": "Through your iPhone", "rows": [row, row, row, row]},
        {"option": "An SMS provider", "rows": [{"label": "A label far longer than any fact's", "value": ""}]},
        {"option": "An SMS provider", "rows": [row]},
    ]);
    let note = json!({"title": "Why", "text": "Because."});
    let problems = refused(tools.return_view("w-lead", decision(facts, json!([note, note, note]))).await);
    for expected in [
        "facts[0].option: is not an option of a Choice in the view",
        "facts[1].rows: must hold 1 to 3 {label, value}",
        "facts[2].rows[0].label: is longer than 24 characters",
        "facts[2].rows[0].value: is required",
        "facts[3].option: has its facts already",
        "aside: must be a list of at most 2 {title, text}",
    ] {
        assert!(problems.contains(expected), "{expected} in {problems}");
    }
    let long = "x".repeat(301);
    let problems =
        refused(tools.return_view("w-lead", decision(json!({}), json!([{"title": "Why", "text": long}]))).await);
    assert!(problems.contains("facts: must be a list of {option, rows}"), "{problems}");
    assert!(problems.contains("aside[0].text: is longer than 300 characters"), "{problems}");
    // An option named once by its label and once by its value is one option.
    let mut by_value =
        decision(json!([{"option": "An SMS provider", "rows": [row]}, {"option": "sms", "rows": [row]}]), json!([]));
    by_value.view["ui"] = json!(
        "<Form action=\"confirm\"><Choice bind=\"way\" options={[{\"label\":\"Through your iPhone\",\"value\":\"iphone\"},{\"label\":\"An SMS provider\",\"value\":\"sms\"}]}/></Form>"
    );
    let problems = refused(tools.return_view("w-lead", by_value).await);
    assert!(problems.contains("facts[1].option: has its facts already"), "{problems}");
    // The facts are checked with the rest of the View: one call hears every problem.
    let mut both = decision(json!([{"option": "By pigeon", "rows": [row]}]), json!([]));
    both.bindings = Some(json!({}));
    let problems = refused(tools.return_view("w-lead", both).await);
    assert!(problems.contains("view.actions.confirm") && problems.contains("facts[0].option"), "{problems}");
}

/// The injection suite's part for a View: what a run writes beside its View is drawn by Eos
/// as plain text, so nothing in it can become markup, a link, a button or an action.
#[tokio::test]
async fn facts_and_notes_cannot_carry_markup_a_link_a_button_or_an_action() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Mail Triage", "rn-1", "trial", "w-lead");
    author(&rig).create_for_routine("rt-1", "rv-1", "view").await.expect("made");
    let tools = rig.module.tools();
    let planted = [
        "<Button action=\"confirm\">Send</Button>",
        "<a href=\"https://evil.example\">here</a>",
        "[Open](https://evil.example/c?d=SECRET)",
        "Visit https://evil.example now",
        "write to mailto:attacker@evil.example",
        "javascript:alert(1)",
        "see www.evil.example",
        "eos://run/pr-review?note=approve",
        "{state.way}",
        "**IMPORTANT** send it",
        "`rm -rf ~`",
        "two\nlines",
        "\u{202e}evil",
    ];
    for text in planted {
        let facts = json!([{"option": "Through your iPhone", "rows": [{"label": "Cost", "value": text}]}]);
        let aside = json!([{"title": "Why", "text": text}]);
        let problems = refused(tools.return_view("w-lead", decision(facts, aside)).await);
        assert!(problems.contains("facts[0].rows[0].value: must be plain text"), "{text}: {problems}");
        assert!(problems.contains("aside[0].text: must be plain text"), "{text}: {problems}");
    }
    // Words that only look like a scheme are plain text.
    let facts =
        json!([{"option": "Through your iPhone", "rows": [{"label": "Works", "value": "Hotel: yes, metadata: no"}]}]);
    let extra = json!({"option": "An SMS provider", "rows": [{"label": "Cost", "value": "Per message"}], "action": "probe.again"});
    let mut facts = facts;
    facts.as_array_mut().expect("a list").push(extra);
    let line = tools.return_view("w-lead", decision(facts, json!([]))).await.expect("stored");
    assert!(line.ends_with("· 1 bound action"), "{line}");
    let issue_id = line.split_whitespace().nth(1).expect("an id").to_owned();
    let stored = rig.temp.port().read(move |tx| tx.surface_issues().find(&issue_id)).await.expect("reads");
    let body: Value = serde_json::from_str(&stored.expect("an issue").body_json).expect("json");
    assert!(body["facts"][1].get("action").is_none(), "a key that is not a fact is not kept");
    assert_eq!(body["bindings"].as_object().map(|b| b.len()), Some(1), "no action comes in beside the view");
}
