//! One routine end to end in the composed app (09 §10), with fakes only: a PR Review team
//! held as drafts; a pull request polled from the source admits one run; the lead starts two
//! specialists, they report, and the lead's result goes straight to the gate; the draft waits in Needs you and stays open across a restart; sent with one comment
//! removed, it goes out once with its marker and the run ends `sent_edited`; memory learns
//! from that edit a note for the routine, and the next pull request's lead starts with it. A
//! show-only run in between sends nothing.

use std::time::Duration;

use eos_app::App;
use eos_domain::routine::numbers::Outcome;
use eos_domain::routine::run::RunState;
use eos_runtime::http::Method;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

use crate::rig;
use crate::routines_rig::{
    Fakes, call_tool, eventually, inbox, lead, make, page, pull, review_blueprint, run, runs, working_agents,
};

/// PR Review as a team: the reviewer leads, a tester and a reader report to it.
fn team_blueprint() -> Value {
    let agent = |key: &str, lead: bool| {
        json!({"key": key, "name": key.to_uppercase(), "lead": lead, "brief": format!("{key} brief."),
               "model": "sonnet", "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none"})
    };
    let mut blueprint = review_blueprint("Review the pull request.");
    blueprint["who"]["depth"] = json!("team");
    blueprint["who"]["agents"] = json!([agent("reviewer", true), agent("tester", false), agent("reader", false)]);
    blueprint
}

/// A review with a summary and two line comments.
fn review() -> Value {
    let comment = |key: &str, line: i64, text: &str| json!({"key": key, "role": "comment", "text": text, "meta": {"path": "src/login.rs", "line": line, "side": "RIGHT"}});
    json!({"kind": "github.review", "channel": "github", "action": "post_review", "parts": [
        {"key": "summary", "role": "summary", "text": "The login fix works; two small points."},
        comment("c:1", 12, "Name this constant."),
        comment("c:2", 30, "This style nit could go either way."),
    ]})
}

async fn submit(app: &App, agents: &ScriptedRuntime, lead: &str, doc: Value) {
    let result = json!({"kind": "github.review", "headline": "Two small points", "body": doc});
    let reply = call_tool(app, agents, lead, "submit_result", result).await;
    assert!(!reply.is_error, "{}", reply.text);
}

/// The worker of `run`'s specialist `agent`.
async fn specialist(app: &App, run: &str, agent: &str) -> String {
    let id = run.to_owned();
    let sessions = app.store().read(move |tx| tx.routine_sessions().by_run(&id)).await.expect("reads");
    sessions.into_iter().find(|s| s.agent_key.as_deref() == Some(agent)).expect("a session").worker_id
}

/// The memory notes, as the Memory screen lists them.
async fn notes(app: &App) -> Vec<Value> {
    let (status, list) = rig::call(app, Method::Get, "/api/memory/notes", None).await;
    assert_eq!(status, 200, "{list}");
    list["notes"].as_array().cloned().unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sent_edit_becomes_a_note_that_the_next_run_s_lead_receives() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));

    // 1–2. The blueprint is kept; a new pull request is polled and one run admitted.
    let routine = make(&app, team_blueprint()).await;
    fakes.source.page(page(vec![pull(7, "a1", "opened", "Fix the login")], false));
    fakes.poll_again(&app);
    eventually("one run is admitted", || async { !runs(&app, &routine).await.is_empty() }).await;
    let first = runs(&app, &routine).await.remove(0);
    assert_eq!(first.item_key.as_deref(), Some("github:pr:acme/game#7"));

    // 3. The lead starts two specialists; they report; the lead hands in its result.
    let lead_id = lead(&app, &agents, &first.id).await;
    for (agent, task) in [("tester", "Run the tests."), ("reader", "Read the diff.")] {
        let reply = call_tool(&app, &agents, &lead_id, "start_specialist", json!({"agent": agent, "task": task})).await;
        assert!(!reply.is_error, "{}", reply.text);
    }
    for (agent, report) in [("tester", "All tests pass."), ("reader", "The diff is small.")] {
        let worker = specialist(&app, &first.id, agent).await;
        eventually("the specialist's session starts", || async {
            agents.started().iter().any(|s| s.worker_id == worker)
        })
        .await;
        let reply = call_tool(&app, &agents, &worker, "send_message_to_parent", json!({"text": report})).await;
        assert!(!reply.is_error, "{}", reply.text);
    }
    // The lead's turn is still at work: it reads its team's reports from the list.
    let team = call_tool(&app, &agents, &lead_id, "list_specialists", json!({})).await;
    assert!(team.text.contains("All tests pass.") && team.text.contains("The diff is small."), "{}", team.text);
    submit(&app, &agents, &lead_id, review()).await;

    // 4. The gate holds a draft, announced once the run's write is committed.
    let announced = frames
        .until(Duration::from_secs(20), |f| f["reason"] == "inbox:change")
        .await
        .expect("inbox:change is announced");
    let items = inbox(&app).await;
    assert_eq!(items.len(), 1, "the change is readable when it is announced: {announced}");
    let item = items[0]["id"].as_str().expect("an id").to_owned();
    assert_eq!(items[0]["kind"], "draft");
    assert_eq!(run(&app, &first.id).await.state, RunState::WaitingForUser);
    app.shutdown(Duration::from_secs(5)).await;

    // 5. After a restart on the same data the draft is still open and the run still waits.
    let agents = working_agents();
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts again");
    let (status, shown) = rig::call(&app, Method::Get, &format!("/api/inbox/{item}"), None).await;
    assert_eq!((status, shown["item"]["state"].as_str()), (200, Some("open")), "{shown}");
    assert_eq!(run(&app, &first.id).await.state, RunState::WaitingForUser);

    // 6. Sent with the style nit removed: one delivery, with its marker; the run ends edited.
    let mut edited = review();
    edited["parts"].as_array_mut().expect("parts").remove(2);
    let rev = shown["item"]["rev"].as_i64().expect("a revision");
    let (status, sent) =
        rig::call(&app, Method::Post, &format!("/api/inbox/{item}/send"), Some(json!({"rev": rev, "doc": edited})))
            .await;
    assert_eq!(status, 200, "{sent}");
    let delivery = sent["deliveries"][0]["id"].as_str().expect("a delivery").to_owned();
    eventually("the review goes out", || async { !fakes.channels.sent().is_empty() }).await;
    eventually("the run ends", || async { run(&app, &first.id).await.state == RunState::Done }).await;
    let went = fakes.channels.sent();
    assert_eq!(went.len(), 1, "one delivery");
    assert_eq!((went[0].channel.as_str(), went[0].key.as_str()), ("github", delivery.as_str()), "keyed by its marker");
    assert_eq!(went[0].body.parts.len(), 2, "without the removed comment");
    assert_eq!(run(&app, &first.id).await.outcome, Some(Outcome::SentEdited));

    // 7. Memory reads the edit and keeps one note for the routine.
    eventually("a note is learned", || async { !notes(&app).await.is_empty() }).await;
    let learned = notes(&app).await;
    assert_eq!(learned.len(), 1, "{learned:?}");
    let note = &learned[0];
    assert_eq!((note["scope"]["level"].as_str(), note["scope"]["key"].as_str()), (Some("routine"), Some(&*routine)));
    let note_id = note["id"].as_str().expect("an id").to_owned();
    assert!(note["text"].as_str().is_some_and(|t| t.contains("removed a comment")), "{note}");

    // 9. A show-only run in between delivers nothing.
    let trial = json!({"routineId": routine, "door": "routine_page", "input": {"result": "showOnly"},
                       "items": [{"kind": "github.pull_request", "key": "github:pr:acme/game#9", "title": "Tidy", "version": "c1", "untrusted": true}]});
    let (status, started) = rig::call(&app, Method::Post, "/api/runs", Some(trial)).await;
    assert_eq!(status, 201, "{started}");
    let shown_only = started["runs"][0]["id"].as_str().expect("a run").to_owned();
    let lead_id = lead(&app, &agents, &shown_only).await;
    submit(&app, &agents, &lead_id, review()).await;
    eventually("the show-only run ends", || async { run(&app, &shown_only).await.state == RunState::Done }).await;
    assert_eq!(fakes.channels.sent().len(), 1, "nothing more went out");

    // 8. The next pull request's lead starts with the note.
    fakes.source.page(page(vec![pull(8, "b1", "opened", "Dark mode toggle")], false));
    fakes.poll_again(&app);
    eventually("the next run is admitted", || async {
        runs(&app, &routine).await.iter().any(|r| r.item_key.as_deref() == Some("github:pr:acme/game#8"))
    })
    .await;
    let next = runs(&app, &routine).await.into_iter().find(|r| r.item_key.as_deref() == Some("github:pr:acme/game#8"));
    let next_lead = lead(&app, &agents, &next.expect("the run").id).await;
    let spec = agents.started().into_iter().find(|s| s.worker_id == next_lead).expect("the lead's start");
    assert!(spec.notes.iter().any(|n| n.contains(&note_id)), "the lead's notes: {:?}", spec.notes);
    app.shutdown(Duration::from_secs(5)).await;
}
