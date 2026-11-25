//! The Forge end to end in the composed app, on the real engine against its scripted model
//! API (06 G9): a need starts a Forge run; the scripted lead starts the researcher, asks the
//! user which way, starts the builder, which writes an echo package in its build folder, and
//! the reviewer, which passes it; Eos tests it under the sandbox and proposes it; the user
//! starts the live test, then installs it from this computer's dashboard. A second run
//! repairs it with a version whose health fails, and it goes back to the one before. No real
//! model is called and no real credential is read. Skipped, saying so, where the sandbox
//! does not work.

use std::sync::Arc;
use std::time::Duration;

use eos_app::{AgentOptions, App, Options};
use eos_core::accounts::SessionCredential;
use eos_engine::mock_api::{MockApi, Reply};
use eos_runtime::http::Method;
use eos_testkit::{FakeSecretPrompt, TempHome};
use serde_json::{Value, json};

use crate::rig;
use crate::routines_rig::{eventually, inbox};

const ECHO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/capabilities/echo-script");

/// Which of the Forge's sessions a request is from, by its brief.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Role {
    Lead,
    Researcher,
    Builder,
    Reviewer,
    Other,
}

fn role_of(system: &str) -> Role {
    if system.contains("You run the Forge for the need") {
        Role::Lead
    } else if system.contains("You research how Eos could do") {
        Role::Researcher
    } else if system.contains("You build one capability package for Eos") {
        Role::Builder
    } else if system.contains("You review one capability package the Forge built") {
        Role::Reviewer
    } else {
        Role::Other
    }
}

fn call(id: &str, name: &str, input: Value) -> Reply {
    Reply::tool_use(id, name, &input.to_string())
}

/// Its health check, which always fails.
const FAILING_CHECK: &str = "\n[[actions]]\nname = \"check\"\nsummary = \"Check it works.\"\nclass = \"read\"\n\
                             recipient = \"none\"\nrun = [\"/bin/sh\", \"check.sh\"]\ntimeout_s = 5\n\
                             input = { type = \"object\" }\n";

/// The package files of `version`: the echo fixture with offline tests and a live test,
/// and, when `failing`, a health check that always fails.
fn package(version: &str, failing: bool) -> Vec<(String, String)> {
    let manifest = std::fs::read_to_string(format!("{ECHO}/capability.toml")).expect("the fixture");
    let health = if failing { "health = { action = \"check\" }\n" } else { "" };
    let mut manifest = manifest.replace("version = \"1.0.0\"", &format!("version = \"{version}\"")).replace(
        "reach = {",
        &format!("{health}tests = {{ command = [\"/bin/sh\", \"tests/run.sh\"], live = \"echo\" }}\nreach = {{"),
    );
    let mut files = vec![
        ("package/echo.sh".to_owned(), std::fs::read_to_string(format!("{ECHO}/echo.sh")).expect("the fixture")),
        ("package/tests/run.sh".to_owned(), "exit 0\n".to_owned()),
    ];
    if failing {
        manifest.push_str(FAILING_CHECK);
        files.push(("package/check.sh".to_owned(), "exit 3\n".to_owned()));
    }
    files.insert(0, ("package/capability.toml".to_owned(), manifest));
    files
}

/// The session's working folder, as its environment section names it.
fn working_folder(messages: &str) -> String {
    let marker = "Primary working directory: ";
    let at = messages.find(marker).map_or(0, |at| at + marker.len());
    messages[at..].split("\\n").next().unwrap_or_default().to_owned()
}

/// The scripted model: each session's next step, from its brief and what it was told last.
fn respond(body: &[u8]) -> Reply {
    let request: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    // A session's brief is in its system prompt or its first message.
    let system = format!("{} {}", request["system"], request["messages"][0]["content"]);
    let messages = request["messages"].as_array().cloned().unwrap_or_default();
    let said = messages.iter().filter(|m| m["role"] == "assistant").count();
    let last = messages.last().map(|m| m["content"].to_string()).unwrap_or_default();
    let all = request["messages"].to_string();
    let repair = all.contains("1.1.0-NEED");
    let version = if repair { "1.1.0" } else { "1.0.0" };
    match role_of(&system) {
        Role::Lead => {
            // The team hears of a repair through its task.
            let task = if repair { "Repair it: 1.1.0-NEED" } else { "Go." };
            let start = |id: &str, agent: &str| call(id, "start_specialist", json!({"agent": agent, "task": task}));
            let done = |key: &str| {
                call(
                    &format!("toolu_{key}"),
                    "complete_milestone",
                    json!({"key": key, "summary": format!("{key} done.")}),
                )
            };
            if said == 0 {
                start("toolu_research", "researcher")
            } else if last.contains("REPORT-RESEARCH") {
                done("research")
            } else if last.contains("next milestone, `choose`") {
                let question = json!({"question": "Which way should Eos take?", "options": [
                    {"label": "Echo script"}, {"label": "Not now"}]});
                call("toolu_ask", "ask_user", json!({"questions": [question]}))
            } else if last.contains("Echo script") && !all.contains("toolu_choose") {
                done("choose")
            } else if last.contains("next milestone, `build`") {
                start("toolu_build", "builder")
            } else if last.contains("REPORT-BUILD") {
                done("build")
            } else if last.contains("next milestone, `review`") {
                start("toolu_review", "reviewer")
            } else if last.contains("REPORT-REVIEW") {
                done("review")
            } else {
                Reply::text("Waiting for the team.")
            }
        }
        Role::Researcher => match said {
            0 => call(
                "toolu_r1",
                "forge_report",
                json!({"stage": "research", "report": {"options": [{
                "key": "echo", "title": "Echo script", "how": "A small script answers its input.",
                "cost": "free", "setup": "none", "works": "any_mac", "reach": [], "source": "build"}]}}),
            ),
            1 => call("toolu_r2", "send_message_to_parent", json!({"text": "result: REPORT-RESEARCH one way"})),
            _ => Reply::text("Reported."),
        },
        Role::Builder => {
            let files = package(version, repair);
            if said < files.len() {
                let (path, text) = &files[said];
                let path = format!("{}/{path}", working_folder(&format!("{system} {all}")));
                call(&format!("toolu_w{said}"), "Write", json!({"file_path": path, "content": text}))
            } else if said == files.len() {
                let build = json!({"package": "package", "capabilityId": "echo-script", "version": version,
                                   "summary": "Echo.", "option": "echo"});
                call("toolu_b1", "forge_report", json!({"stage": "build", "report": build}))
            } else if said == files.len() + 1 {
                call("toolu_b2", "send_message_to_parent", json!({"text": "result: REPORT-BUILD its tests pass"}))
            } else {
                Reply::text("Built.")
            }
        }
        Role::Reviewer => match said {
            0 => call(
                "toolu_v1",
                "forge_report",
                json!({"stage": "review", "report": {"verdict": "pass", "findings": []}}),
            ),
            1 => call("toolu_v2", "send_message_to_parent", json!({"text": "result: REPORT-REVIEW pass"})),
            _ => Reply::text("Reviewed."),
        },
        Role::Other => Reply::text("Nothing to do."),
    }
}

struct NoPicker;

impl eos_core::shell::FilePicker for NoPicker {
    fn pick_directory(&self) -> eos_core::BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }

    fn pick_files(&self) -> eos_core::BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async { None })
    }
}

struct Forge {
    app: App,
    prompt: Arc<FakeSecretPrompt>,
    _mock: MockApi,
    _home: TempHome,
    _claude: tempfile::TempDir,
}

impl Forge {
    async fn new() -> Self {
        let mock = MockApi::responder(([127, 0, 0, 1], 0).into(), respond).await.expect("the scripted model API");
        let home = TempHome::new();
        let claude = tempfile::tempdir().expect("a folder");
        let prompt = Arc::new(FakeSecretPrompt::new());
        let shell = eos_app::Shell {
            views: eos_testkit::FakeBrowserViews::new(),
            panel: eos_testkit::FakeBrowserPanel::new(),
            picker: Arc::new(NoPicker),
            secret_prompt: prompt.clone(),
            opener: Arc::new(eos_testkit::FakeBrowser::default()),
            work_hold: Arc::new(eos_testkit::FakeWorkHold::new()),
            dock_badge: Arc::new(eos_testkit::FakeDockBadge::new()),
        };
        let options = Options {
            agents: AgentOptions {
                base_url: Some(mock.base_url()),
                claude_home: Some(claude.path().to_owned()),
                no_mcp: true,
                default_model: Some("mock-model".into()),
                credential: Some(SessionCredential::ApiKey { provider: "anthropic".into(), key: "k-forge".into() }),
                ..AgentOptions::default()
            },
            shell: Some(shell),
            // A secret the live test asks for is kept in memory; the network is on only for
            // that (no relay, vault or account is handed in).
            reaches_network: true,
            keychain: Some(Arc::new(eos_testkit::FakeCapabilitySecrets::new())),
            ..Options::new(home.path())
        };
        let app = App::build(options).expect("builds");
        app.start().await.expect("starts");
        Self { app, prompt, _mock: mock, _home: home, _claude: claude }
    }

    async fn ask(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        rig::call(&self.app, method, target, body).await
    }

    /// A Forge run for `need`, through to its proposal; `None` where the sandbox does not work.
    async fn proposed(&self, need: Value) -> Option<String> {
        let (status, started) = self.ask(Method::Post, "/api/forge", Some(need)).await;
        assert!(status == 200 || status == 201, "{started}");
        let run = started["runId"].as_str().expect("a run").to_owned();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let (_, row) = self.ask(Method::Get, &format!("/api/runs/{run}"), None).await;
            if row["run"]["state"] == "failed" {
                if row.to_string().contains("sandbox") {
                    eprintln!("skipped: the sandbox does not work on this Mac");
                    return None;
                }
                panic!("the Forge run failed: {row}");
            }
            let items = self.answer_questions().await;
            if items.iter().any(|item| item["kind"] == "capability_install" && item["runId"] == json!(run)) {
                return Some(run);
            }
            assert!(tokio::time::Instant::now() < deadline, "no proposal; the run: {row}; waiting: {}", json!(items));
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Answers each question waiting with its first choice; the items waiting.
    async fn answer_questions(&self) -> Vec<Value> {
        let items = inbox(&self.app).await;
        for item in items.iter().filter(|item| item["kind"] == "question") {
            let id = item["id"].as_str().unwrap_or_default();
            // The list leaves out what an item carries; its detail has the questions.
            let (_, detail) = self.ask(Method::Get, &format!("/api/inbox/{id}"), None).await;
            let questions = detail["payload"]["questions"].as_array().cloned().unwrap_or_default();
            let answers: serde_json::Map<String, Value> = questions
                .iter()
                .map(|q| (q["question"].as_str().unwrap_or_default().to_owned(), q["options"][0]["label"].clone()))
                .collect();
            let answer = json!({"rev": item["rev"], "answer": {"kind": "question", "answers": answers}});
            let target = format!("/api/inbox/{id}/answer");
            let (status, body) = self.ask(Method::Post, &target, Some(answer)).await;
            assert_eq!(status, 200, "{body}");
        }
        items
    }

    async fn answer(&self, run: &str, choice: &str) -> (u16, Value) {
        self.ask(Method::Post, &format!("/api/forge/proposals/{run}/answer"), Some(json!({"choice": choice}))).await
    }

    async fn installed(&self) -> Option<String> {
        let (_, list) = self.ask(Method::Get, "/api/capabilities", None).await;
        let rows = list["capabilities"].as_array().or(list.as_array()).cloned().unwrap_or_default();
        rows.iter().find(|row| row["id"] == "echo-script").and_then(|row| row["version"].as_str().map(str::to_owned))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_need_goes_through_research_build_tests_review_live_test_install_and_rollback() {
    let forge = Forge::new().await;
    let Some(run) = forge.proposed(json!({"need": "Answer my text back to me."})).await else { return };

    // The proposal is what was built, tested and reviewed; nothing is installed yet.
    let (status, state) = forge.ask(Method::Get, &format!("/api/forge/proposals/{run}"), None).await;
    assert_eq!((status, state["proposal"]["version"].as_str()), (200, Some("1.0.0")), "{state}");
    assert_eq!(forge.installed().await, None);
    assert_eq!(forge.answer(&run, "install").await.0, 409, "not before the live test");

    // The live test asks the secret in the app's own prompt and calls the package confined.
    forge.prompt.answer(Some("tok_typed_in_prompt_e2e"));
    let (status, live) =
        forge.ask(Method::Post, &format!("/api/forge/proposals/{run}/live-test"), Some(json!({}))).await;
    assert_eq!((status, live["state"].as_str()), (200, Some("sent")), "{live}");
    assert!(!live.to_string().contains("tok_typed"), "no secret on the wire");
    assert_eq!(forge.answer(&run, "alerted").await.0, 200);
    let (status, answered) = forge.answer(&run, "install").await;
    assert_eq!(status, 200, "{answered}");
    eventually("the capability is installed", || async { forge.installed().await.as_deref() == Some("1.0.0") }).await;

    // A repair whose health fails within a day goes back to the version before.
    let repair = json!({"need": "Repair the echo: 1.1.0-NEED", "capabilityId": "echo-script"});
    let Some(second) = forge.proposed(repair).await else { return };
    forge.prompt.answer(Some("tok_typed_in_prompt_e2e"));
    let (status, _) =
        forge.ask(Method::Post, &format!("/api/forge/proposals/{second}/live-test"), Some(json!({}))).await;
    assert_eq!(status, 200);
    assert_eq!(forge.answer(&second, "alerted").await.0, 200);
    assert_eq!(forge.answer(&second, "install").await.0, 200);
    eventually("the notice that it went back", || async {
        inbox(&forge.app).await.iter().any(|item| {
            item["kind"] == "notice" && item["title"].as_str().is_some_and(|t| t.contains("went back to version 1.0.0"))
        })
    })
    .await;
    assert_eq!(forge.installed().await.as_deref(), Some("1.0.0"));
    assert!(forge.app.shutdown(Duration::from_secs(5)).await.clean());
}
