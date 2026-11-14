//! The question routes against the recorded wire, and an asker inside the app.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::UnknownRecord;
use eos_contracts::stream::topics::NOTIFICATION_FIRE;
use eos_core::agent::{OpenQuestions, UserNotifier, UserQuestions};
use eos_core::store::{EventOrder, EventQuery};
use eos_mod_questions::{Questions, QuestionsModule};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::fixtures::recorded_response;
use eos_testkit::{FakeClock, SeqIds, TempStore};
use serde_json::{Value, json};

struct App {
    runtime: Runtime,
    questions: Questions,
    temp: TempStore,
}

async fn app() -> App {
    let temp = TempStore::seeded("/sandbox");
    let kernel = Kernel::new(KernelOptions::default());
    let questions =
        Questions::new(temp.port(), kernel.bus.clone(), Arc::new(FakeClock::new()), Arc::new(SeqIds::new()));
    let module = Arc::new(QuestionsModule::new(questions.clone()));
    let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
    runtime.lifecycle.start().await.expect("starts");
    App { runtime, questions, temp }
}

async fn call(app: &App, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = Request::new(method, target, Caller::DASHBOARD);
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body.to_string());
    }
    let res = app.runtime.router.handle(request).await;
    let bytes = res.body.collect().await.expect("a body");
    (res.status, serde_json::from_slice(&bytes).expect("json"))
}

/// What a recorded step answered, by name.
fn recorded(step: &str) -> (u16, Value) {
    let response = recorded_response("42-chat-writes", step);
    (response["status"].as_u64().expect("status") as u16, response["json"].clone())
}

fn question(text: &str) -> Value {
    json!({"question": text, "header": "Rollout", "multiSelect": false,
           "options": [{"label": "Yes", "description": "Off by default"}, {"label": "No", "description": "Always on"}]})
}

/// The rows a write announced on `topic`, as JSON.
fn announced(app: &App, topic: &str) -> Vec<Value> {
    let all = app.temp.announced.list();
    all.iter().filter(|(t, _)| *t == topic).map(|(_, json)| serde_json::from_str(json).expect("json")).collect()
}

#[tokio::test]
async fn a_question_is_asked_polled_and_answered_as_recorded() {
    let app = app().await;
    let ask = json!({"questions": [question("Ship the flag behind a setting?")]});
    let (status, opened) = call(&app, Method::Post, "/workers/o-ORCH/question", Some(ask)).await;
    assert_eq!(status, 200);
    // The app names the tool call when the asker named none.
    assert_eq!(opened, json!({"questionId": "p-00000002", "toolUseId": "p-00000001"}));
    assert!(app.questions.has_open("o-ORCH"));
    let banner = &announced(&app, NOTIFICATION_FIRE)[0];
    let recorded_banner =
        &recorded_response("42-chat-writes", "question-register")["frames"]["main"][1]["data"]["payload"];
    assert_eq!(
        (&banner["title"], &banner["body"], &banner["workerId"]),
        (&recorded_banner["title"], &recorded_banner["body"], &recorded_banner["workerId"])
    );
    assert_eq!(banner.as_object().expect("an object").len(), recorded_banner.as_object().expect("an object").len());

    let poll = "/workers/o-ORCH/question/p-00000002";
    assert_eq!(call(&app, Method::Get, poll, None).await, recorded("question-poll-waiting"));

    let answer = json!({"toolUseId": "p-00000001", "answers": {"Ship the flag behind a setting?": "Yes"}});
    let answered = call(&app, Method::Post, "/workers/o-ORCH/question-answer", Some(answer)).await;
    assert_eq!(answered, recorded("question-answer"));
    assert_eq!(call(&app, Method::Get, poll, None).await, recorded("question-poll-answered"));
    // A lost answer may be read again.
    assert_eq!(call(&app, Method::Get, poll, None).await, recorded("question-poll-answered"));
    assert!(!app.questions.has_open("o-ORCH"));

    // The chat's rows: the banner, then what closed it.
    let query = EventQuery {
        worker_id: "o-ORCH".into(),
        since: 0,
        limit: 2,
        order: EventOrder::Desc,
        before_id: None,
        after_id: None,
    };
    let rows = app.temp.port().read(move |tx| tx.events().list(&query)).await.expect("rows");
    let rows: Vec<(String, String)> =
        rows.into_iter().rev().map(|row| (row.kind, row.payload.unwrap_or_default())).collect();
    assert_eq!(rows[0].0, "question_answered");
    assert_eq!(rows[0].1, r#"{"toolUseId":"p-00000001","answers":{"Ship the flag behind a setting?":"Yes"}}"#);
    assert_eq!(rows[1].0, "question_pending");
    assert!(
        rows[1].1.starts_with(r#"{"toolUseId":"p-00000001","questions":[{"question":"Ship the flag"#),
        "{}",
        rows[1].1
    );
}

#[tokio::test]
async fn a_dismissal_an_unknown_question_and_a_bad_request_answer_as_recorded() {
    let app = app().await;
    let ask = json!({"toolUseId": "call_ask_wire", "questions": [question("Which name?")]});
    let (_, opened) = call(&app, Method::Post, "/workers/o-ORCH/question", Some(ask)).await;
    assert_eq!(opened["toolUseId"], "call_ask_wire");
    let poll = format!("/workers/o-ORCH/question/{}", opened["questionId"].as_str().expect("an id"));

    let dismiss = json!({"toolUseId": "call_ask_wire", "dismissed": true});
    assert_eq!(
        call(&app, Method::Post, "/workers/o-ORCH/question-answer", Some(dismiss)).await,
        recorded("question-dismiss")
    );
    assert_eq!(call(&app, Method::Get, &poll, None).await, recorded("question-poll-dismissed"));

    // Nobody asked under this tool call: the banner row is closed all the same.
    let gone = json!({"toolUseId": "call_never_asked", "answers": {}});
    let before = announced(&app, "worker:change").len();
    assert_eq!(
        call(&app, Method::Post, "/workers/o-ORCH/question-answer", Some(gone)).await,
        recorded("question-answer-gone")
    );
    assert_eq!(announced(&app, "worker:change").len(), before + 1);
    assert_eq!(
        call(&app, Method::Get, "/workers/o-ORCH/question/q-nope", None).await,
        recorded("question-poll-unknown")
    );
    assert_eq!(
        call(&app, Method::Post, "/workers/o-ORCH/question", Some(json!({"questions": []}))).await,
        recorded("question-invalid")
    );
}

#[tokio::test]
async fn the_question_routes_for_an_asker_stay_on_this_computer() {
    let app = app().await;
    let from_afar = Caller::Peer { device: "abc".into(), human: true };
    for (method, target) in [(Method::Post, "/workers/o-ORCH/question"), (Method::Get, "/workers/o-ORCH/question/p-1")]
    {
        let res = app.runtime.router.handle(Request::new(method, target, from_afar.clone())).await;
        assert_eq!(res.status, 403, "{target}");
    }
}

fn asked(text: &str) -> Vec<UnknownRecord> {
    vec![serde_json::from_value(question(text)).expect("a record")]
}

/// Waits until the asker's question is open; the wait itself has no clock.
async fn until_open(app: &App, worker_id: &str) {
    let waiting = async {
        while announced(app, "worker:change").is_empty() || !app.questions.has_open(worker_id) {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(20), waiting).await.expect("the question opens");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_waits_for_the_users_answer() {
    let app = app().await;
    let questions = app.questions.clone();
    let asking = tokio::spawn(async move { questions.ask("o-ORCH", None, asked("Ship it?")).await });
    until_open(&app, "o-ORCH").await;
    let answer = json!({"toolUseId": "p-00000001", "answers": {"Ship it?": "Yes"}});
    let (_, outcome) = call(&app, Method::Post, "/workers/o-ORCH/question-answer", Some(answer)).await;
    assert_eq!(outcome["outcome"], "answered");
    let answers = asking.await.expect("the asker").expect("answers");
    assert_eq!(json!(answers), json!({"Ship it?": "Yes"}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dismissed_question_ends_the_wait_without_answers() {
    let app = app().await;
    let questions = app.questions.clone();
    // A focused session's question carries its own tool call's id.
    let asking = tokio::spawn(async move { questions.ask("o-ORCH", Some("toolu_1"), asked("Ship it?")).await });
    until_open(&app, "o-ORCH").await;
    let dismiss = json!({"toolUseId": "toolu_1", "dismissed": true});
    call(&app, Method::Post, "/workers/o-ORCH/question-answer", Some(dismiss)).await;
    assert_eq!(asking.await.expect("the asker"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_asker_that_stops_waiting_takes_its_question_back() {
    let app = app().await;
    let questions = app.questions.clone();
    let asking = tokio::spawn(async move { questions.ask("o-ORCH", None, asked("Ship it?")).await });
    until_open(&app, "o-ORCH").await;
    // The turn is interrupted: the tool call's future is dropped.
    asking.abort();
    let closed = async {
        while app.questions.has_open("o-ORCH") {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(20), closed).await.expect("the banner closes");
    assert_eq!(app.questions.poll("p-00000002").status, eos_contracts::QuestionPollResponseStatus::Dismissed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_workers_question_is_forgotten_and_a_question_that_makes_no_sense_is_not_asked() {
    let app = app().await;
    let questions = app.questions.clone();
    let asking = tokio::spawn(async move { questions.ask("o-ORCH", None, asked("Ship it?")).await });
    until_open(&app, "o-ORCH").await;
    app.runtime.kernel.bus.publish_raw("worker:removed", None, json!({"workerId": "o-ORCH"}).to_string().into());
    assert_eq!(asking.await.expect("the asker"), None);
    assert_eq!(app.questions.poll("p-00000002").status, eos_contracts::QuestionPollResponseStatus::Gone);

    let nonsense: Vec<UnknownRecord> = vec![serde_json::from_value(json!({"question": 5})).expect("a record")];
    assert_eq!(app.questions.ask("o-ORCH", None, nonsense).await, None);
    assert_eq!(app.questions.ask("o-ORCH", None, Vec::new()).await, None);
}

#[tokio::test]
async fn a_banner_for_the_user_is_announced_as_recorded() {
    let app = app().await;
    let mut heard = app.runtime.kernel.bus.subscribe(NOTIFICATION_FIRE, 4);
    app.questions.notify("o-ORCH", "Build finished", "All tests pass.");
    let event = tokio::time::timeout(Duration::from_secs(20), heard.recv()).await.expect("in time").expect("an event");
    let mut ours: Value = event.payload_as().expect("json");
    let mut theirs = recorded_response("42-chat-writes", "notify")["frames"]["main"][0]["data"]["payload"].clone();
    // The time is the clock's own on each side.
    assert!(ours["ts"].is_i64());
    ours["ts"] = Value::Null;
    theirs["ts"] = Value::Null;
    assert_eq!(ours, theirs);
}
