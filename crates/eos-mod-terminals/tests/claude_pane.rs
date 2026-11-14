//! A Code-view Claude pane, end to end: a real PTY, the real launch command
//! with its hooks, and a stand-in for Claude Code (`examples/fake_claude.rs`:
//! no model, no network) that the hooks run inside. Never the real `claude`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use eos_core::RandomIds;
use eos_core::SystemClock;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_terminals::{RunDeps, SessionDeps, TerminalsModule};
use eos_platform::PosixShell;
use eos_pty::{ClaudeTranscriptFiles, PtyTerminals, ShellRunner};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClaudeEnv, FakeClaudeProgram, TempStore};
use serde_json::{Value, json};

static SH: LazyLock<PosixShell> = LazyLock::new(|| PosixShell::fixed("/bin/sh"));

/// `target/<profile>/examples/fake_claude`. `cargo test` builds it with the
/// package's tests; a run of this test alone builds it here.
fn fake_claude() -> PathBuf {
    let test_binary = std::env::current_exe().expect("this test");
    let profile = test_binary.parent().and_then(Path::parent).expect("the target folder");
    let path = profile.join("examples/fake_claude");
    if !path.exists() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
        let mut build = std::process::Command::new(cargo);
        build.args(["build", "--quiet", "-p", "eos-mod-terminals", "--example", "fake_claude"]);
        if profile.ends_with("release") {
            build.arg("--release");
        }
        let built = build.current_dir(env!("CARGO_MANIFEST_DIR")).status().expect("cargo");
        assert!(built.success() && path.exists(), "{} could not be built", path.display());
    }
    path
}

struct Pane {
    runtime: Runtime,
    home: tempfile::TempDir,
    project: PathBuf,
    _store: TempStore,
}

impl Pane {
    /// The app's terminals with a stand-in for the user's Claude (`None`: not installed).
    fn new(claude: Option<PathBuf>) -> Self {
        let home = tempfile::tempdir().expect("a home");
        let project = home.path().join("project");
        std::fs::create_dir(&project).expect("a project");
        let store = TempStore::new();
        let kernel = Kernel::new(KernelOptions::default());
        let trees =
            ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
        // Nobody's profile, nobody's Claude folder: the pane's home is the temporary one.
        let env = vec![
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("HOME".to_owned(), home.path().to_string_lossy().into_owned()),
        ];
        let module = TerminalsModule::new(
            SessionDeps {
                terminals: Arc::new(PtyTerminals::new(&*SH)),
                claude: Arc::new(FakeClaudeProgram(claude.map(|p| p.to_string_lossy().into_owned()))),
                claude_env: Arc::new(FakeClaudeEnv(Some(env))),
                bus: kernel.bus.clone(),
                ids: Arc::new(RandomIds),
                clock: Arc::new(SystemClock),
                default_cwd: project.to_string_lossy().into_owned(),
            },
            Arc::new(ClaudeTranscriptFiles::new(home.path())),
            RunDeps {
                commands: Arc::new(ShellRunner::new(Runner::new(trees), &*SH, None)),
                store: store.port(),
                bus: kernel.bus.clone(),
                jobs: kernel.jobs.clone(),
                clock: Arc::new(SystemClock),
                ids: Arc::new(RandomIds),
            },
        );
        let runtime = Runtime::build(kernel, vec![Arc::new(module)], Arc::new(AllPluginsOn)).expect("composes");
        Self { runtime, home, project, _store: store }
    }

    async fn call_as(&self, caller: Caller, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        let mut req = Request::new(method, target, caller);
        if let Some(body) = body {
            req = req.body(body.to_string());
        }
        let res = self.runtime.router.handle(req).await;
        let status = res.status;
        let bytes = res.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn call(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        self.call_as(Caller::DASHBOARD, method, target, body).await
    }

    async fn conversation(&self, id: &str) -> Value {
        let (status, body) = self.call(Method::Get, &format!("/pty/{id}/conversation"), None).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    /// Reads the conversation until `ready` says so.
    async fn conversation_when(&self, id: &str, what: &str, ready: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let conversation = self.conversation(id).await;
            if ready(&conversation) {
                return conversation;
            }
            assert!(Instant::now() < deadline, "never saw {what}: {conversation}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Waits until the stand-in (not the shell that starts it) has the terminal.
    async fn claude_in_front(&self, id: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let (_, list) = self.call(Method::Get, "/pty", None).await;
            let titled = list["sessions"]
                .as_array()
                .is_some_and(|all| all.iter().any(|s| s["sessionId"] == id && s["title"] == "Fake Claude"));
            if titled {
                return;
            }
            assert!(Instant::now() < deadline, "the pane never showed Claude's title: {list}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn texts(conversation: &Value) -> Vec<String> {
    let rows = conversation["rows"].as_array().cloned().unwrap_or_default();
    rows.iter()
        .filter_map(|row| match row["type"].as_str()? {
            "user_message" => Some(format!("user: {}", row["payload"]["text"].as_str()?)),
            _ => row["payload"]["blocks"]
                .as_array()?
                .iter()
                .find_map(|b| Some(format!("claude: {}", b["text"].as_str()?))),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_pane_is_launched_followed_prompted_and_answered() {
    let pane = Pane::new(Some(fake_claude()));
    let folder = pane.project.to_string_lossy().into_owned();

    let (status, session) =
        pane.call(Method::Post, "/pty", Some(json!({ "cols": 100, "rows": 30, "cwd": folder, "claude": {} }))).await;
    assert_eq!(status, 200, "{session}");
    assert_eq!(session["kind"], "claude");
    let id = session["sessionId"].as_str().expect("an id").to_owned();
    let first = session["claudeSessionId"].as_str().expect("a pinned conversation").to_owned();
    pane.claude_in_front(&id).await;

    // Nothing said yet: an empty conversation under the pinned id.
    let empty = pane.conversation(&id).await;
    assert_eq!(empty, json!({ "claudeSessionId": first, "rows": [], "running": false, "pending": null }));

    // A prompt is pasted and submitted; Claude records it and answers.
    let message = |text: &str| json!({ "text": text });
    assert_eq!(
        pane.call(Method::Post, &format!("/pty/{id}/message"), Some(message("hello there"))).await,
        (200, json!({ "ok": true }))
    );
    let said = pane.conversation_when(&id, "the answer", |c| texts(c).len() == 2 && c["running"] == false).await;
    assert_eq!(texts(&said), ["user: hello there", "claude: echo: hello there"]);
    assert!(pane.home.path().join(".claude/projects").exists(), "the transcript is where Claude keeps it");

    // Only what came after a row is read again.
    let last = said["rows"][1]["id"].as_i64().expect("an id");
    let (_, after) = pane.call(Method::Get, &format!("/pty/{id}/conversation?afterId={}", last - 1), None).await;
    assert_eq!(after["rows"].as_array().map(Vec::len), Some(1));

    // A question: the hook reports it while the transcript does not have it yet.
    assert_eq!(pane.call(Method::Post, &format!("/pty/{id}/message"), Some(message("ask me"))).await.0, 200);
    let asked = pane.conversation_when(&id, "the open question", |c| !c["pending"].is_null()).await;
    assert_eq!(asked["pending"]["name"], "AskUserQuestion");
    assert_eq!(asked["pending"]["input"]["questions"][0]["options"], json!([{ "label": "Red" }, { "label": "Blue" }]));
    let call = asked["pending"]["toolUseId"].as_str().expect("a call id").to_owned();

    // Typed into an open dialog a prompt would answer it with garbage.
    assert_eq!(
        pane.call(Method::Post, &format!("/pty/{id}/message"), Some(message("never mind"))).await,
        (409, json!({ "error": "Claude is waiting for an answer", "pending": "AskUserQuestion" }))
    );
    let answer_route = format!("/pty/{id}/answer");
    let answer = |body: Value| pane.call(Method::Post, &answer_route, Some(body));
    assert_eq!(
        answer(json!({ "toolUseId": call, "answers": [{ "options": [0, 1] }] })).await,
        (400, json!({ "error": "question 1 takes exactly one option" }))
    );
    assert_eq!(
        answer(json!({ "toolUseId": "another", "answers": [{ "options": [1] }] })).await,
        (409, json!({ "error": "that question is no longer open" }))
    );
    assert_eq!(
        answer(json!({ "toolUseId": call, "answers": [{ "options": [1] }] })).await,
        (200, json!({ "ok": true }))
    );
    // A second device answering the same dialog would type into the composer.
    assert_eq!(answer(json!({ "toolUseId": call, "answers": [{ "options": [0] }] })).await.0, 409);
    let answered =
        pane.conversation_when(&id, "the pick", |c| texts(c).last().is_some_and(|t| t.contains("You picked"))).await;
    assert_eq!(
        texts(&answered).last().map(String::as_str),
        Some("claude: You picked 2."),
        "option 2: the second digit"
    );
    assert_eq!(answered["pending"], Value::Null);

    // A plan is approved with its first option.
    assert_eq!(pane.call(Method::Post, &format!("/pty/{id}/message"), Some(message("plan it"))).await.0, 200);
    let planned = pane.conversation_when(&id, "the plan", |c| c["pending"]["name"] == "ExitPlanMode").await;
    let plan = planned["pending"]["toolUseId"].as_str().expect("a call id").to_owned();
    assert_eq!(answer(json!({ "toolUseId": plan })).await, (400, json!({ "error": "expected approve: true" })));
    assert_eq!(answer(json!({ "toolUseId": plan, "approve": true })).await, (200, json!({ "ok": true })));
    pane.conversation_when(&id, "the approval", |c| texts(c).last().is_some_and(|t| t == "claude: You picked 1."))
        .await;

    // `/clear` moves the pane to a new conversation: the session hook says which.
    assert_eq!(pane.call(Method::Post, &format!("/pty/{id}/message"), Some(message("/clear"))).await.0, 200);
    let cleared = pane.conversation_when(&id, "the new conversation", |c| c["claudeSessionId"] != first.as_str()).await;
    assert_eq!(cleared["rows"], json!([]));

    // The phone reads and types, and may not resize.
    let phone = Caller::Phone { grant: Tier::High, mutate: true };
    assert_eq!(pane.call_as(phone.clone(), Method::Get, &format!("/pty/{id}/conversation"), None).await.0, 200);
    assert_eq!(
        pane.call_as(phone.clone(), Method::Post, &format!("/pty/{id}/input"), Some(json!({ "data": "x" }))).await.0,
        200
    );
    assert_eq!(
        pane.call_as(phone, Method::Post, &format!("/pty/{id}/resize"), Some(json!({ "cols": 50, "rows": 20 })))
            .await
            .0,
        403
    );

    // Leaving Claude drops the pane back to its shell: keys are no longer sent there.
    assert_eq!(
        pane.call(Method::Post, &format!("/pty/{id}/input"), Some(json!({ "data": "\u{7f}/exit\r" }))).await.0,
        200
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (status, body) = pane.call(Method::Post, &format!("/pty/{id}/message"), Some(message("ls"))).await;
        if status == 409 {
            assert_eq!(body, json!({ "error": "Claude is not running in this terminal" }));
            break;
        }
        assert!(Instant::now() < deadline, "the shell never came back");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    assert_eq!(pane.call(Method::Delete, &format!("/pty/{id}"), None).await, (200, json!({ "ok": true })));
    let deadline = Instant::now() + Duration::from_secs(20);
    while pane.call(Method::Get, "/pty", None).await.1 != json!({ "sessions": [] }) {
        assert!(Instant::now() < deadline, "the session never ended");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    pane.runtime.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn without_claude_installed_the_pane_is_refused_with_the_reason() {
    let pane = Pane::new(None);
    let (status, body) = pane.call(Method::Post, "/pty", Some(json!({ "cols": 80, "rows": 24, "claude": {} }))).await;
    assert_eq!(status, 409);
    assert!(
        body["error"].as_str().is_some_and(|e| e.starts_with("Claude Code is not installed on this computer")),
        "{body}"
    );
    assert_eq!(pane.call(Method::Get, "/pty", None).await.1, json!({ "sessions": [] }));
}
