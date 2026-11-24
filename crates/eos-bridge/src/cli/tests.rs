use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::cli::{CliFrame, exit};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use super::{CliGateway, CliParts};
use crate::core::{Core, Plane};
use crate::testdir::Dir;
use crate::transport::{Req, Sink};

type Answers = dyn Fn(&str, &str, &Value) -> (u16, Value) + Send + Sync;

/// Answers each call by `answers` and keeps what was asked: method, path and body.
struct FakeCore {
    answers: Box<Answers>,
    asked: Mutex<Vec<(String, String, Value)>>,
}

impl Core for FakeCore {
    fn ui_token(&self) -> String {
        "tok".into()
    }

    fn call(&self, _plane: Plane, req: Req, sink: Sink) {
        assert_eq!(req.header(crate::token::TOKEN_HEADER), Some("tok"), "every call carries the dashboard's token");
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let (status, answer) = (self.answers)(&req.method, &req.url, &body);
        self.asked.lock().unwrap().push((req.method, req.url, body));
        sink.respond(status, vec![("content-type".into(), "application/json".into())], answer.to_string().as_bytes());
    }
}

const ROUTINES: &str = r#"[
  {"id": "rt-1", "slug": "pr-review", "name": "PR Review", "summary": "Reviews pull requests", "state": "active"},
  {"id": "rt-2", "slug": "old", "name": "Old", "summary": "Gone", "state": "deleted"}
]"#;

fn routines_and(more: impl Fn(&str, &str, &Value) -> Option<(u16, Value)> + Send + Sync + 'static) -> Box<Answers> {
    Box::new(move |method, url, body| {
        if (method, url) == ("GET", "/api/routines") {
            return (200, serde_json::from_str(ROUTINES).unwrap());
        }
        more(method, url, body).unwrap_or((404, json!({ "error": "not found" })))
    })
}

struct Rig {
    dir: Dir,
    core: Arc<FakeCore>,
    gateway: Option<CliGateway>,
}

impl Rig {
    fn new(answers: Box<Answers>) -> Self {
        let dir = Dir::new("cli");
        let core = Arc::new(FakeCore { answers, asked: Mutex::default() });
        let parts =
            CliParts { core: core.clone(), data_dir: dir.path().join("shell"), scheme: "eos", version: "0.2.0".into() };
        let gateway = CliGateway::start(parts, &tokio::runtime::Handle::current()).expect("listens");
        Rig { dir, core, gateway: Some(gateway) }
    }

    async fn connect(&self) -> UnixStream {
        UnixStream::connect(self.dir.path().join("shell/cli.sock")).await.expect("connects")
    }

    /// Sends one request and reads every frame up to `done`.
    async fn ask(&self, request: Value) -> Vec<CliFrame> {
        let stream = self.connect().await;
        let (read, mut write) = stream.into_split();
        write.write_all(format!("{request}\n").as_bytes()).await.unwrap();
        let mut lines = BufReader::new(read).lines();
        let mut frames = Vec::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            let frame: CliFrame = serde_json::from_str(&line).expect("a frame");
            let done = matches!(frame, CliFrame::Done { .. });
            frames.push(frame);
            if done {
                break;
            }
        }
        drop(write);
        frames
    }

    fn asked(&self, method: &str, path: &str) -> Vec<Value> {
        let asked = self.core.asked.lock().unwrap();
        asked.iter().filter(|(m, u, _)| m == method && u == path).map(|(_, _, b)| b.clone()).collect()
    }
}

fn texts(frames: &[CliFrame]) -> Vec<String> {
    frames
        .iter()
        .filter_map(|f| match f {
            CliFrame::Out { text } | CliFrame::Err { text } | CliFrame::Confirm { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn code(frames: &[CliFrame]) -> i32 {
    match frames.last() {
        Some(CliFrame::Done { exit }) => *exit,
        other => panic!("no done frame: {other:?}"),
    }
}

#[tokio::test]
async fn hello_and_routines_answer_and_the_socket_is_the_users_alone_until_the_app_quits() {
    let mut rig = Rig::new(routines_and(|_, _, _| None));
    let socket = rig.dir.path().join("shell/cli.sock");
    assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);
    let hello = rig.ask(json!({"cmd": "hello"})).await;
    assert_eq!(hello[0], CliFrame::Hello { version: "0.2.0".into(), ready: true });
    let listed = rig.ask(json!({"cmd": "routines"})).await;
    assert_eq!(code(&listed), exit::OK);
    let lines = texts(&listed);
    assert_eq!(lines.len(), 1, "a deleted routine is not listed: {lines:?}");
    assert!(lines[0].starts_with("pr-review") && lines[0].contains("PR Review"), "{lines:?}");
    let as_json = rig.ask(json!({"cmd": "routines", "json": true})).await;
    assert!(matches!(&as_json[0], CliFrame::Json { value } if value[0]["slug"] == "pr-review"));
    assert_eq!(rig.gateway.as_ref().unwrap().status()["served"], 3);
    rig.gateway = None;
    assert!(!socket.exists(), "the socket goes with the gateway");
}

fn started(method: &str, url: &str, _: &Value) -> Option<(u16, Value)> {
    match (method, url) {
        ("POST", "/api/runs") => Some((200, json!({"runs": [{"id": "rn-82fa1c0d3e9b", "state": "queued"}]}))),
        ("POST", "/api/runs/estimate") => Some((200, json!({"usd": 1.5, "ms": 60000, "basis": "history", "n": 4}))),
        _ => None,
    }
}

#[tokio::test]
async fn a_run_starts_through_the_start_route_as_the_terminal_with_untrusted_items() {
    let rig = Rig::new(routines_and(started));
    let frames = rig.ask(json!({"cmd": "run", "routine": "pr-review", "items": ["#470"], "note": "the tests", "options": {"depth": "deep"}})).await;
    assert_eq!(code(&frames), exit::OK);
    assert_eq!(texts(&frames), ["Started PR Review on #470. Open it: eos://runs/rn-82fa1c0d3e9b"]);
    let body = &rig.asked("POST", "/api/runs")[0];
    assert_eq!((body["routineId"].as_str(), body["door"].as_str()), (Some("rt-1"), Some("terminal")));
    assert_eq!(body["input"]["item"], json!({"kind": "text", "text": "#470", "untrusted": true}));
    assert_eq!(
        (body["input"]["note"].as_str(), body["input"]["options"]["depth"].as_str()),
        (Some("the tests"), Some("deep"))
    );
    assert!(body["clientRequestId"].as_str().is_some_and(|id| id.starts_with("cli-")));

    let missing = rig.ask(json!({"cmd": "run", "routine": "old"})).await;
    assert_eq!(code(&missing), exit::REFUSED, "a deleted routine takes no run");
    let bad = rig.ask(json!({"cmd": "run", "routine": "PR Review"})).await;
    assert_eq!(code(&bad), exit::REFUSED);
    let unknown = rig.ask(json!({"cmd": "dance"})).await;
    assert_eq!(code(&unknown), exit::REFUSED);
    assert_eq!(rig.asked("POST", "/api/runs").len(), 1);
}

#[tokio::test]
async fn several_items_ask_first_and_start_only_with_yes() {
    let rig = Rig::new(routines_and(started));
    let asked = json!({"cmd": "run", "routine": "pr-review", "items": ["1", "https://example.com/pr/2"]});
    let frames = rig.ask(asked.clone()).await;
    assert_eq!(code(&frames), exit::REFUSED);
    assert!(
        matches!(&frames[0], CliFrame::Confirm { text } if text == "Start 2 runs of PR Review? About $1.50 in all.")
    );
    assert!(rig.asked("POST", "/api/runs").is_empty(), "nothing starts before the user agrees");
    let mut yes = asked;
    yes["yes"] = json!(true);
    assert_eq!(code(&rig.ask(yes).await), exit::OK);
    let items = &rig.asked("POST", "/api/runs")[0]["items"];
    assert_eq!(items[1], json!({"kind": "link", "url": "https://example.com/pr/2", "untrusted": true}));
}

#[tokio::test(start_paused = true)]
async fn wait_follows_the_run_to_its_end_and_its_ending_decides_the_code() {
    let polls = Arc::new(Mutex::new(0));
    let seen = polls.clone();
    let rig = Rig::new(routines_and(move |method, url, _| match (method, url) {
        ("GET", "/api/runs/rn-82fa1c0d3e9b") => {
            let mut n = seen.lock().unwrap();
            *n += 1;
            let run = match *n {
                1 => json!({"state": "running", "station": "work", "needsUser": false}),
                2 => json!({"state": "waiting_for_user", "station": "deliver", "needsUser": true}),
                3 => json!({"state": "waiting_for_user", "station": "deliver", "needsUser": true}),
                _ => json!({"state": "done", "station": "deliver", "needsUser": false}),
            };
            Some((200, json!({ "run": run })))
        }
        ("GET", "/api/inbox") => Some((200, json!({"items": [{"id": "ib-7", "runId": "rn-82fa1c0d3e9b"}]}))),
        ("GET", "/api/runs/rn-82fa1c0d3e9b/result") => {
            Some((200, json!({"headline": "Two problems found", "body": {"text": "Line 4 leaks."}})))
        }
        _ => started(method, url, &Value::Null),
    }));
    let frames = rig.ask(json!({"cmd": "run", "routine": "pr-review", "wait": true})).await;
    assert_eq!(code(&frames), exit::OK);
    assert_eq!(
        texts(&frames),
        [
            "Started PR Review. Open it: eos://runs/rn-82fa1c0d3e9b",
            "running · work",
            "waiting_for_user · deliver",
            "It waits for you: eos://inbox/ib-7",
            "done · deliver",
            "Two problems found",
            "Line 4 leaks.",
        ]
    );
    assert_eq!(*polls.lock().unwrap(), 4, "read once a second until it ended");
}

#[tokio::test]
async fn a_run_that_failed_ends_with_one() {
    let rig = Rig::new(routines_and(|method, url, body| match url {
        "/api/runs/rn-82fa1c0d3e9b" => Some((200, json!({"run": {"state": "failed", "reason": "the budget ran out"}}))),
        _ => started(method, url, body),
    }));
    let frames = rig.ask(json!({"cmd": "run", "routine": "pr-review", "wait": true})).await;
    assert_eq!(code(&frames), exit::RUN_FAILED);
    assert!(texts(&frames).contains(&"the budget ran out".to_owned()));
}

#[tokio::test]
async fn a_refusal_is_said_in_one_line_and_ends_with_two() {
    let rig = Rig::new(routines_and(|method, url, _| match (method, url) {
        ("POST", "/api/eos/halt") => Some((200, json!({"on": true}))),
        ("POST", "/api/runs/once") => Some((403, json!({"error": "refused in a dev run"}))),
        _ => None,
    }));
    let halted = rig.ask(json!({"cmd": "halt"})).await;
    assert_eq!((code(&halted), texts(&halted)[0].starts_with("Routines stopped")), (exit::OK, true));
    let once = rig.ask(json!({"cmd": "once", "what": "Tidy my downloads"})).await;
    assert_eq!((code(&once), texts(&once)), (exit::REFUSED, vec!["refused in a dev run".to_owned()]));
}

#[tokio::test(start_paused = true)]
async fn a_request_too_large_or_too_late_is_closed_without_an_answer() {
    let rig = Rig::new(routines_and(|_, _, _| None));
    let mut big = rig.connect().await;
    let line = format!("{{\"cmd\":\"once\",\"what\":\"{}\"}}\n", "x".repeat(eos_contracts::cli::CLI_REQUEST_MAX_BYTES));
    let _ = big.write_all(line.as_bytes()).await;
    let mut answer = String::new();
    let _ = BufReader::new(&mut big).read_line(&mut answer).await;
    assert_eq!(answer, "", "past 2 MiB nothing is answered");

    let silent = rig.connect().await;
    tokio::time::sleep(Duration::from_secs(11)).await;
    let mut answer = String::new();
    let _ = BufReader::new(silent).read_line(&mut answer).await;
    assert_eq!(answer, "", "a request must come within 10 s");
    assert_eq!(rig.gateway.as_ref().unwrap().status()["dropped"], 2);
}

#[tokio::test(start_paused = true)]
async fn at_most_eight_commands_are_served_at_once() {
    let rig = Rig::new(routines_and(|_, _, _| None));
    let mut open = Vec::new();
    for _ in 0..8 {
        open.push(rig.connect().await);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut ninth = rig.connect().await;
    let _ = ninth.write_all(b"{\"cmd\":\"hello\"}\n").await;
    let mut answer = String::new();
    let _ = BufReader::new(&mut ninth).read_line(&mut answer).await;
    assert_eq!(answer, "", "the ninth is closed at once");
    drop(open);
}

#[tokio::test]
async fn a_memory_hook_hands_its_input_on_and_prints_only_the_answer() {
    let rig = Rig::new(routines_and(|method, url, body| match (method, url) {
        ("POST", "/api/memory/hook") if body["event"] == "PreToolUse" => {
            Some((200, json!({"hookSpecificOutput": {"additionalContext": "Run the tests with --release."}})))
        }
        _ => None,
    }));
    let input = json!({"tool_name": "Bash", "tool_input": {"command": "cargo test"}});
    let frames = rig.ask(json!({"cmd": "memoryHook", "event": "PreToolUse", "input": input})).await;
    assert_eq!(code(&frames), exit::OK);
    assert!(
        matches!(&frames[0], CliFrame::Json { value } if value["hookSpecificOutput"]["additionalContext"] == "Run the tests with --release.")
    );
    assert_eq!(rig.asked("POST", "/api/memory/hook")[0]["input"], input);
    let nothing = rig.ask(json!({"cmd": "memoryHook", "event": "Stop", "input": {}})).await;
    assert_eq!(nothing, vec![CliFrame::Done { exit: exit::OK }], "no answer prints nothing");
}
