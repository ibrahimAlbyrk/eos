//! A press of a button: the arguments come only from the stored issue and
//! the user's input, a confirmation is good once and for two minutes and
//! needs the name typed for what cannot be taken back, a
//! repeated client id answers its first record, and an action out of scope
//! or out of shape never runs.

use eos_core::inbox::ActionDecision;
use eos_core::store::StoredIssue;
use eos_runtime::http::Method;
use eos_surface::{Level, Place};
use serde_json::{Value, json};

use crate::rig::{Rig, issue, surface};

/// A View issue of `sf-a` (routine `rt-1`) with bound sends.
fn view_issue() -> StoredIssue {
    let mut issue = issue("si-1", "sf-a");
    issue.body_json = json!({
        "view": {"title": "Digest", "summary": "Mail", "ui": "<Text>Hi</Text>",
                 "data": {"lead": {"url": "https://example.com/a"},
                          "stories": [{"id": "s-1", "url": "https://example.com/one"}, {"url": "https://example.com/two"}]},
                 "actions": {"dig": {"label": "Dig", "kind": "send", "text": "x"}}},
        "bindings": {
            "dig": {"action": "probe.with", "args": {"item": "{data.lead.url}", "note": "{state.note}"}},
            "again": {"action": "probe.again"},
            "open": {"action": "probe.with", "list": "data.stories", "args": {"item": "{item.url}"}},
            "erase": {"action": "probe.erase"},
            "broken": {"action": "probe.fails"},
            "ghost": {"action": "probe.nowhere"},
            "bad": {"action": "probe.with", "args": {"item": "not a url"}}}
    })
    .to_string();
    issue
}

async fn rig() -> Rig {
    let rig = Rig::new().await;
    rig.seed(vec![surface("sf-a", "rt-1", Level::View, Place::NeedsYou, 1)], vec![], vec![view_issue()]).await;
    rig
}

async fn press(rig: &Rig, body: Value) -> (u16, Value) {
    rig.ask(Method::Post, "/api/actions/run", Some(body)).await
}

#[tokio::test]
async fn a_frame_cannot_pass_its_own_arguments() {
    let rig = rig().await;
    let body = json!({"issueId": "si-1", "actionId": "dig", "clientId": "c-1", "state": {"note": "call back"},
                      "args": {"item": "https://evil.example/"}});
    let (status, answer) = press(&rig, body).await;
    assert_eq!(status, 200);
    assert_eq!(answer["status"], "done");
    assert_eq!(answer["result"], json!({"echo": {"item": "https://example.com/a", "note": "call back"}}));
    let heard = rig.heard.lock().expect("heard").clone();
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].routine_id.as_deref(), Some("rt-1"), "the issue's routine owns the press");
    assert_eq!(heard[0].origin, "dashboard");
    let asked = rig.gate.asked();
    assert_eq!((asked[0].routine_id.as_str(), asked[0].action_id.as_str()), ("rt-1", "probe.with"));

    let record_id = answer["recordId"].as_str().expect("a record").to_owned();
    let (status, record) = rig.ask(Method::Get, &format!("/api/actions/records/{record_id}"), None).await;
    assert_eq!(status, 200);
    assert_eq!((record["status"].as_str(), record["decision"].as_str()), (Some("done"), Some("run")));
    assert_eq!(record["surfaceId"], "sf-a");
    let topics = rig.temp.announced.list();
    assert_eq!(topics.iter().filter(|(t, _)| *t == "actions:record").count(), 2, "recorded, then finished");
}

#[tokio::test]
async fn a_repeated_client_id_answers_its_first_record() {
    let rig = rig().await;
    let body = json!({"issueId": "si-1", "actionId": "again", "clientId": "same"});
    let (_, first) = press(&rig, body.clone()).await;
    let (_, second) = press(&rig, body).await;
    assert_eq!(first, second);
    assert_eq!(rig.heard.lock().expect("heard").len(), 1, "ran once");
}

#[tokio::test]
async fn what_is_out_of_scope_or_out_of_shape_never_runs() {
    let rig = rig().await;
    for (body, reason) in [
        (json!({"issueId": "si-1", "actionId": "nobody", "clientId": "a"}), "That button runs nothing"),
        (json!({"issueId": "si-1", "actionId": "ghost", "clientId": "b"}), "That action does not exist"),
        (json!({"issueId": "si-9", "actionId": "dig", "clientId": "c"}), "That issue is gone"),
        (json!({"actionId": "probe.again", "clientId": "d"}), "That action runs only from its routine's surface"),
        (json!({"issueId": "si-1", "button": "b", "clientId": "e"}), "That issue has no such button"),
    ] {
        let (status, answer) = press(&rig, body.clone()).await;
        assert_eq!((status, answer), (200, json!({"status": "refused", "reason": reason})), "{body}");
    }
    let (_, bad) = press(&rig, json!({"issueId": "si-1", "actionId": "bad", "clientId": "f"})).await;
    assert!(bad["reason"].as_str().is_some_and(|r| r.contains("item: must be an http or https address")), "{bad}");
    assert!(rig.heard.lock().expect("heard").is_empty());
    assert!(rig.gate.asked().is_empty(), "nothing reached the gate");

    let (_, global) = press(&rig, json!({"actionId": "probe.global", "clientId": "g"})).await;
    assert_eq!(global["status"], "done", "an action for any surface runs without an issue");
    let (_, failed) = press(&rig, json!({"issueId": "si-1", "actionId": "broken", "clientId": "h"})).await;
    assert_eq!(failed["reason"], "It broke");
    let record = rig
        .ask(Method::Get, &format!("/api/actions/records/{}", failed["recordId"].as_str().unwrap_or_default()), None)
        .await
        .1;
    assert_eq!((record["status"].as_str(), record["errorKind"].as_str()), (Some("failed"), Some("broken")));
}

#[tokio::test]
async fn the_gate_holds_refuses_or_asks_and_a_confirmation_is_good_once() {
    let rig = rig().await;
    rig.gate.set(ActionDecision::Hold { item_id: "nd-1".into() });
    let (_, held) = press(&rig, json!({"issueId": "si-1", "actionId": "again", "clientId": "h"})).await;
    assert_eq!((held["status"].as_str(), held["itemId"].as_str()), (Some("held"), Some("nd-1")));
    rig.gate.set(ActionDecision::Refuse { reason: "Eos is stopped".into() });
    let (_, refused) = press(&rig, json!({"issueId": "si-1", "actionId": "again", "clientId": "r"})).await;
    assert_eq!(refused["reason"], "Eos is stopped");
    assert!(refused["recordId"].is_string(), "a refusal of the gate is recorded");
    assert!(rig.heard.lock().expect("heard").is_empty());

    rig.gate.set(ActionDecision::Confirm { prompt: "Type it".into() });
    let ask = json!({"issueId": "si-1", "actionId": "again", "clientId": "k"});
    let (status, asked) = press(&rig, ask.clone()).await;
    assert_eq!((status, asked["status"].as_str(), asked["prompt"].as_str()), (202, Some("confirm"), Some("Type it")));
    let token = asked["token"].as_str().expect("a token").to_owned();
    let mut confirmed = ask.clone();
    confirmed["confirm"] = json!(token);
    let (_, done) = press(&rig, confirmed.clone()).await;
    assert_eq!(done["status"], "done");
    let (_, again) = press(&rig, confirmed).await;
    assert_eq!(again["status"], "done", "the repeat answers the first record");
    assert_eq!(rig.heard.lock().expect("heard").len(), 1);

    let late = json!({"issueId": "si-1", "actionId": "again", "clientId": "late"});
    let (_, asked) = press(&rig, late.clone()).await;
    rig.clock.advance(2 * 60 * 1000 + 1);
    let mut confirmed = late;
    confirmed["confirm"] = asked["token"].clone();
    let (_, expired) = press(&rig, confirmed).await;
    assert_eq!(expired["reason"], "That confirmation is no longer good");
    let forged = json!({"issueId": "si-1", "actionId": "again", "clientId": "late", "confirm": "made-up"});
    assert_eq!(press(&rig, forged).await.1["status"], "refused");
    assert_eq!(rig.heard.lock().expect("heard").len(), 1, "an expired or forged token runs nothing");
}

#[tokio::test]
async fn what_cannot_be_taken_back_goes_only_once_its_name_is_typed() {
    let rig = rig().await;
    rig.gate.set(ActionDecision::Confirm { prompt: "Probe cannot be taken back. Type its name to go ahead.".into() });
    let ask = json!({"issueId": "si-1", "actionId": "erase", "clientId": "x"});
    let (_, asked) = press(&rig, ask.clone()).await;
    assert_eq!((asked["status"].as_str(), asked["typeToConfirm"].as_str()), (Some("confirm"), Some("Probe")));
    let mut confirmed = ask.clone();
    confirmed["confirm"] = asked["token"].clone();
    for typed in [None, Some("Prob")] {
        let mut attempt = confirmed.clone();
        if let Some(typed) = typed {
            attempt["typed"] = json!(typed);
        }
        let (_, answer) = press(&rig, attempt).await;
        assert_eq!(
            (answer["status"].as_str(), answer["reason"].as_str()),
            (Some("refused"), Some("Type Probe to go ahead"))
        );
    }
    assert!(rig.heard.lock().expect("heard").is_empty(), "a click alone runs nothing");
    confirmed["typed"] = json!(" probe ");
    let (_, done) = press(&rig, confirmed).await;
    assert_eq!(done["status"], "done", "the token stays good while the name is typed again");
    assert_eq!(rig.heard.lock().expect("heard").len(), 1);

    // What can be taken back asks for no name.
    let (_, plain) = press(&rig, json!({"issueId": "si-1", "actionId": "again", "clientId": "y"})).await;
    assert!(plain.get("typeToConfirm").is_none(), "{plain}");
}

#[tokio::test]
async fn the_registry_lists_every_action_with_its_argument_type() {
    let rig = rig().await;
    let (status, list) = rig.ask(Method::Get, "/api/actions", None).await;
    assert_eq!(status, 200);
    let ids: Vec<_> = list["actions"].as_array().expect("actions").iter().map(|a| a["id"].clone()).collect();
    assert!(ids.contains(&json!("surface.keep_issue")) && ids.contains(&json!("probe.with")), "{ids:?}");
    let with =
        list["actions"].as_array().expect("actions").iter().find(|a| a["id"] == "probe.with").cloned().expect("listed");
    assert_eq!(with["scope"], "owner_routine");
    assert_eq!(with["args"]["fields"]["item"], json!({"type": "url"}));
}

#[tokio::test]
async fn a_button_on_a_list_row_runs_on_the_row_it_was_pressed_on() {
    let rig = rig().await;
    let by_id = json!({"issueId": "si-1", "actionId": "open", "clientId": "r-1", "itemId": "s-1"});
    assert_eq!(press(&rig, by_id).await.1["result"], json!({"echo": {"item": "https://example.com/one"}}));
    let by_index = json!({"issueId": "si-1", "actionId": "open", "clientId": "r-2", "index": 1});
    assert_eq!(press(&rig, by_index).await.1["result"], json!({"echo": {"item": "https://example.com/two"}}));
    for (n, (row, why)) in [
        (json!({}), "no row named"),
        (json!({"itemId": "s-9"}), "an id that names no row"),
        (json!({"index": 7}), "an index past the rows"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut pressed = json!({"issueId": "si-1", "actionId": "open", "clientId": format!("r-bad-{n}")});
        pressed.as_object_mut().expect("an object").extend(row.as_object().cloned().unwrap_or_default());
        let (_, answer) = press(&rig, pressed).await;
        assert_eq!(
            (answer["status"].as_str(), answer["reason"].as_str()),
            (Some("refused"), Some("That button needs the row it was pressed on")),
            "{why}"
        );
    }
    assert_eq!(rig.heard.lock().expect("heard").len(), 2, "only the two presses on a row ran");
}
