//! What a user does, end to end on the composed app with a scripted engine:
//! the rows, the stream frames and the side effects together, in the order the
//! TypeScript use-cases produce them (`DispatchMessage`, `CompactContext`,
//! `AskSideQuestion`, archive / purge, page edits, plugin installs, a quit).

#[path = "support/rig.rs"]
mod rig;

use std::time::Duration;

use eos_app::App;
use eos_runtime::http::{Method, Request};
use eos_testkit::agent::Turn;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(20);

struct Bench {
    home: TempHome,
    _folder: tempfile::TempDir,
    cwd: String,
    agents: ScriptedRuntime,
    app: App,
    frames: rig::Frames,
}

impl Bench {
    async fn new() -> Self {
        Self::with_files(&[]).await
    }

    /// With files of the data folder (`policy.yaml`, `config.json`), read when the app starts.
    async fn with_files(files: &[(&str, &str)]) -> Self {
        let home = TempHome::new();
        for (name, text) in files {
            std::fs::write(home.join(name), text).expect("a file");
        }
        let folder = tempfile::tempdir().expect("a folder");
        let cwd = folder.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
        let agents = ScriptedRuntime::new();
        agents.otherwise(rig::turn_for);
        let app = rig::build(home.path(), &agents);
        app.start().await.expect("starts");
        let frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
        Self { home, _folder: folder, cwd, agents, app, frames }
    }

    async fn call(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        rig::call(&self.app, method, target, body).await
    }

    /// A request as an agent's tool makes it: no ui-token, the agent named.
    async fn as_agent(&self, agent: &str, method: Method, target: &str, body: Value) -> (u16, Value) {
        let request = Request::new(method, target, self.app.callers().classify(None))
            .header("x-eos-agent-id", agent)
            .header("content-type", "application/json")
            .body(body.to_string());
        let response = self.app.router().handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.unwrap_or_default();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn chat(&mut self, prompt: &str) -> String {
        let id = rig::focused_chat(&self.app, &self.cwd, prompt).await;
        self.until_state(&id, "IDLE").await;
        id
    }

    async fn until_state(&mut self, id: &str, state: &str) {
        let seen = self.frames.until(WAIT, |f| rig::went(f, id, state)).await;
        assert!(seen.is_some(), "{id} went {state}");
    }

    async fn rows(&self, id: &str) -> Vec<Value> {
        let (_, rows) = self.call(Method::Get, &format!("/workers/{id}/events?limit=5000&order=asc"), None).await;
        rows.as_array().cloned().unwrap_or_default()
    }

    async fn row(&self, id: &str) -> (u16, Value) {
        self.call(Method::Get, &format!("/workers/{id}"), None).await
    }
}

fn payload(row: &Value) -> Value {
    row["payload"].as_str().and_then(|p| serde_json::from_str(p).ok()).unwrap_or(Value::Null)
}

fn of_type<'a>(rows: &'a [Value], kind: &str) -> Vec<&'a Value> {
    rows.iter().filter(|r| r["type"] == kind).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_click_on_a_visual_answer_reaches_the_model_and_shows_as_a_reply_chip() {
    let mut b = Bench::new().await;
    let chat = b.chat("[reply] two cafes?").await;
    let present = json!({"input": {
        "title": "Two cafes", "tone": "teal", "icon": "coffee",
        "data": {"places": [{"type": "Place", "id": "a", "name": "Bean", "rating": 4.5}]},
        "actions": {"pick": {"label": "Pick {name}", "kind": "send"}},
        "ui": "<List of=\"places\" variant=\"row\" actions=\"pick\"/>",
        "summary": "Bean (4.5)."}});
    let (status, made) = b.as_agent(&chat, Method::Post, "/api/genui/views", present).await;
    assert_eq!(status, 201, "{made}");
    let view = made["viewId"].as_str().expect("a view").to_owned();

    // The click, while the agent is busy: it waits in the queue and goes out as the same turn.
    let release = b.agents.script_held(Turn::reply("busy"));
    let (status, _) =
        b.call(Method::Post, &format!("/workers/{chat}/message"), Some(json!({"text": "[long] go"}))).await;
    assert!(status < 300);
    b.until_state(&chat, "WORKING").await;
    let action = json!({"viewId": view, "actionId": "pick", "label": "Pick Bean", "viewTitle": "Two cafes",
        "item": {"id": "a", "name": "Bean"}, "state": {"open": true}});
    let click = json!({"text": "Pick Bean", "action": action, "queueWhenBusy": true});
    let (status, body) = b.call(Method::Post, &format!("/workers/{chat}/message"), Some(click)).await;
    assert!(status < 300, "{body}");
    release.release();
    b.until_state(&chat, "IDLE").await;
    b.until_state(&chat, "IDLE").await;

    let model = format!(
        "[view action] Pick Bean\n{{\"viewId\":\"{view}\",\"actionId\":\"pick\",\"item\":{{\"id\":\"a\",\"name\":\"Bean\"}},\"state\":{{\"open\":true}}}}"
    );
    let sent = b.agents.sent(&chat);
    // Every operator turn opens with its message id line, as today (`message-id.ts`).
    let last = sent.last().map(String::as_str).unwrap_or_default();
    assert!(last.starts_with("<msg id=\"") && last.ends_with(&format!("/>\n{model}")), "what the model read: {sent:?}");
    let rows = b.rows(&chat).await;
    let chip = of_type(&rows, "user_message").into_iter().map(payload).find(|p| p["action"].is_object());
    let chip = chip.expect("the click is a stored message");
    assert_eq!(chip["action"], json!({"viewId": view, "label": "Pick Bean", "viewTitle": "Two cafes"}), "{chip}");
    assert_eq!(chip["text"], "Pick Bean", "the chat shows the label: {chip}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_long_chat_compacts_at_the_idle_edge_and_the_messages_queued_meanwhile_go_out_once_after() {
    let mut b = Bench::new().await;
    let chat = b.chat("[reply] hi").await;
    // A turn that fills the context past the threshold, and two messages sent while it runs.
    let release = b.agents.script_held(Turn::of(vec![rig::context(950_000)]));
    let (status, _) = b.call(Method::Post, &format!("/workers/{chat}/message"), Some(json!({"text": "go on"}))).await;
    assert!(status < 300);
    b.until_state(&chat, "WORKING").await;
    for (n, text) in ["first queued", "second queued"].iter().enumerate() {
        let body = json!({"text": text, "clientMsgId": format!("q{n}"), "queueWhenBusy": true});
        let (status, answer) = b.call(Method::Post, &format!("/workers/{chat}/message"), Some(body)).await;
        assert!(status < 300, "{answer}");
    }
    release.release();
    // Rest comes only when the queue is empty and the compaction is over.
    let deadline = tokio::time::Instant::now() + WAIT;
    let rows = loop {
        b.until_state(&chat, "IDLE").await;
        let rows = b.rows(&chat).await;
        let delivered = of_type(&rows, "user_message").len();
        if (delivered >= 4 && !of_type(&rows, "compaction_completed").is_empty())
            || tokio::time::Instant::now() > deadline
        {
            break rows;
        }
    };
    let order: Vec<String> = rows
        .iter()
        .filter_map(|r| match r["type"].as_str()? {
            "user_message" => Some(format!("message:{}", payload(r)["text"].as_str().unwrap_or_default())),
            kind @ ("compaction_started" | "compaction_completed") => Some(kind.to_owned()),
            _ => None,
        })
        .collect();
    let sent = b.agents.sent(&chat);
    println!("rows {order:?}\nsent {sent:?}");
    assert_eq!(order.iter().filter(|o| o.as_str() == "message:first queued").count(), 1, "{order:?}");
    assert_eq!(order.iter().filter(|o| o.as_str() == "message:second queued").count(), 1, "{order:?}");
    let at = |what: &str| order.iter().position(|o| o == what).unwrap_or(usize::MAX);
    assert!(at("compaction_completed") < usize::MAX, "the chat was compacted: {order:?}");
    assert!(at("message:first queued") < at("message:second queued"), "queued messages keep their order");
    assert_eq!(sent.iter().filter(|s| s.contains("first queued")).count(), 1, "the agent got each queued message once");
    assert!(
        b.agents.calls().iter().any(|c| matches!(c, eos_testkit::agent::Call::ReplaceContext { .. })),
        "the session was reseeded"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_side_question_during_a_running_turn_answers_and_leaves_the_turn_and_transcript_alone() {
    let mut b = Bench::new().await;
    let chat = b.chat("[reply] hi").await;
    let release = b.agents.script_held(Turn::reply("still working"));
    b.call(Method::Post, &format!("/workers/{chat}/message"), Some(json!({"text": "do the long thing"}))).await;
    b.until_state(&chat, "WORKING").await;
    let (status, answer) =
        b.call(Method::Post, &format!("/workers/{chat}/btw"), Some(json!({"question": "what are you doing?"}))).await;
    assert_eq!(status, 200, "{answer}");
    assert!(answer.to_string().contains("side answer to: what are you doing?"), "{answer}");
    let (_, row) = b.row(&chat).await;
    assert_eq!(row["state"], "WORKING", "the turn goes on");
    release.release();
    b.until_state(&chat, "IDLE").await;
    let rows = b.rows(&chat).await;
    let mentioned =
        rows.iter().filter(|r| r["payload"].as_str().is_some_and(|p| p.contains("what are you doing"))).count();
    assert_eq!(mentioned, 0, "nothing of the side question entered the transcript");
    assert_eq!(of_type(&rows, "user_message").len(), 2, "only the two messages sent to the chat");
    assert!(
        !b.agents.sent(&chat).iter().any(|s| s.contains("what are you doing")),
        "the question never reached the conversation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn archive_restore_and_purge_move_a_chat_and_everything_hanging_on_it() {
    let mut b = Bench::new().await;
    let chat = b.chat("[tools] look").await;
    let (status, _) = b
        .as_agent(
            &chat,
            Method::Post,
            "/api/genui/views",
            json!({"input": {"title": "t", "ui": "<Text>x</Text>", "summary": "s"}}),
        )
        .await;
    assert_eq!(status, 201);
    let listed = |workers: &Value| workers.as_array().into_iter().flatten().any(|w| w["id"] == chat.as_str());

    let (status, _) = b.call(Method::Post, &format!("/workers/{chat}/archive"), None).await;
    assert_eq!(status, 200);
    assert_eq!(eos_core::agent::AgentRuntime::live(&b.agents), 0, "archiving stops the session");
    assert!(!listed(&b.call(Method::Get, "/workers", None).await.1), "an archived chat leaves the list");
    assert!(listed(&b.call(Method::Get, "/workers/archived", None).await.1), "and shows among the archived");

    let (status, _) = b.call(Method::Post, &format!("/workers/{chat}/restore"), None).await;
    assert_eq!(status, 200);
    assert!(listed(&b.call(Method::Get, "/workers", None).await.1), "a restored chat is back");
    let (status, _) =
        b.call(Method::Post, &format!("/workers/{chat}/message"), Some(json!({"text": "[reply] again"}))).await;
    assert!(status < 300, "a restored chat takes messages");
    b.until_state(&chat, "IDLE").await;

    b.call(Method::Post, &format!("/workers/{chat}/archive"), None).await;
    let (status, _) = b.call(Method::Delete, &format!("/workers/{chat}/purge"), None).await;
    assert_eq!(status, 200);
    let removed =
        b.frames.until(WAIT, |f| f["reason"] == "worker:removed" && f["payload"]["workerId"] == chat.as_str()).await;
    assert!(removed.is_some(), "the stream says it is gone");
    assert_eq!(b.row(&chat).await.0, 404);
    assert!(b.rows(&chat).await.is_empty(), "its transcript is gone");
    assert!(!listed(&b.call(Method::Get, "/workers/archived", None).await.1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_edit_during_the_users_edit_is_a_conflict_the_user_resolves_on_the_new_revision() {
    let mut b = Bench::new().await;
    let chat = b.chat("[reply] hi").await;
    let (status, made) = b
        .call(Method::Post, "/api/pages", Some(json!({"title": "Plan", "body": "- [ ] one\n", "project": b.cwd})))
        .await;
    assert_eq!(status, 201);
    let page = made["page"]["id"].as_str().expect("a page").to_owned();
    let opened = made["page"]["rev"].as_i64().expect("a revision");

    let (status, edited) = b
        .as_agent(&chat, Method::Post, &format!("/api/pages/{page}/edit"), json!({"op": "append", "text": "- [ ] two"}))
        .await;
    assert_eq!(status, 200, "{edited}");
    let changed = b.frames.until(WAIT, |f| f["reason"] == "pages:change" && f.to_string().contains(&page)).await;
    assert!(changed.is_some(), "the user's tab hears of the agent's edit");

    let mine = json!({"body": "- [x] one\n", "baseRev": opened});
    let (status, conflict) = b.call(Method::Put, &format!("/api/pages/{page}"), Some(mine)).await;
    assert_eq!(status, 409, "{conflict}");
    let theirs = &conflict["page"];
    assert!(
        theirs["body"].as_str().is_some_and(|t| t.contains("two")),
        "the conflict carries the agent's text: {conflict}"
    );
    let merged = json!({"body": "- [x] one\n- [ ] two\n", "baseRev": theirs["rev"]});
    let (status, saved) = b.call(Method::Put, &format!("/api/pages/{page}"), Some(merged)).await;
    assert_eq!(status, 200, "{saved}");
    let (_, read) = b.call(Method::Get, &format!("/api/pages/{page}"), None).await;
    assert_eq!(read["page"]["body"], "- [x] one\n- [ ] two\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_from_a_folder_is_installed_switched_and_removed() {
    let mut b = Bench::new().await;
    let source = b.home.join("plugin-src");
    std::fs::create_dir_all(&source).expect("a folder");
    std::fs::write(
        source.join("plugin.json"),
        r#"{ "id": "flow-sample", "name": "Flow sample", "description": "From a folder.", "version": "0.1.0" }"#,
    )
    .expect("a manifest");
    let install = json!({"source": {"kind": "local", "path": source.to_string_lossy()}});
    let (status, staged) = b.call(Method::Post, "/api/plugins/install", Some(install)).await;
    assert_eq!(status, 200, "{staged}");
    let staging = staged["staged"]["stagingId"].as_str().expect("staged").to_owned();
    let (status, _) = b.call(Method::Post, &format!("/api/plugins/install/{staging}"), None).await;
    assert_eq!(status, 200);
    assert!(b.frames.until(WAIT, |f| f["reason"] == "plugins:change").await.is_some());
    let on = |plugins: &Value| {
        plugins["plugins"].as_array().into_iter().flatten().find(|p| p["id"] == "flow-sample").cloned()
    };
    assert!(on(&b.call(Method::Get, "/api/plugins", None).await.1).is_some(), "installed");

    for enabled in [false, true] {
        let (status, _) =
            b.call(Method::Put, "/api/plugins/flow-sample/enabled", Some(json!({"enabled": enabled}))).await;
        assert_eq!(status, 200);
        let listed = on(&b.call(Method::Get, "/api/plugins", None).await.1).expect("listed");
        assert_eq!(listed["enabled"], enabled, "{listed}");
    }
    let (status, _) = b.call(Method::Delete, "/api/plugins/flow-sample", None).await;
    assert_eq!(status, 200);
    assert!(on(&b.call(Method::Get, "/api/plugins", None).await.1).is_none(), "removed");
    assert!(!b.home.join("plugins/flow-sample").exists(), "its folder went to the trash");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_memory_an_agent_suggests_is_kept_by_the_user_and_reaches_the_profile_preview() {
    let mut b = Bench::new().await;
    let chat = b.chat("[reply] hi").await;
    let suggestion = json!({"text": "When asked for a summary, give at most three lines.", "category": "work-style",
        "scope": "global", "why": "Said twice."});
    let (status, made) = b.as_agent(&chat, Method::Post, "/api/user-memories/suggest", suggestion).await;
    assert_eq!(status, 201, "{made}");
    let id = made["memory"]["id"].as_str().expect("an id").to_owned();
    assert!(b.frames.until(WAIT, |f| f["reason"] == "user-memory:change").await.is_some());
    let (status, kept) = b.call(Method::Post, &format!("/api/user-memories/{id}/approve"), None).await;
    assert_eq!(status, 200, "{kept}");
    let (_, preview) = b.call(Method::Get, "/api/profile/preview", None).await;
    assert!(preview.to_string().contains("at most three lines"), "what agents see holds the kept memory: {preview}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_quit_mid_turn_then_a_resume_picks_the_chat_up_with_its_queue() {
    let home = TempHome::new();
    let folder = tempfile::tempdir().expect("a folder");
    let cwd = folder.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let chat = {
        let agents = ScriptedRuntime::new();
        let app = rig::build(home.path(), &agents);
        app.start().await.expect("starts");
        let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
        let _held = agents.script_held(Turn::reply("never"));
        let chat = rig::focused_chat(&app, &cwd, "a long job").await;
        assert!(frames.until(WAIT, |f| rig::went(f, &chat, "WORKING")).await.is_some());
        let queued = json!({"text": "then this", "clientMsgId": "c-then", "queueWhenBusy": true});
        rig::call(&app, Method::Post, &format!("/workers/{chat}/message"), Some(queued)).await;
        app.shutdown(Duration::from_secs(5)).await;
        chat
    };
    let agents = ScriptedRuntime::new();
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts again");
    let mut frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
    let (_, row) = rig::call(&app, Method::Get, &format!("/workers/{chat}"), None).await;
    assert_eq!(row["state"], "SUSPENDED", "{row}");
    let (status, resumed) = rig::call(&app, Method::Post, &format!("/workers/{chat}/resume"), Some(json!({}))).await;
    assert!(status < 300, "{resumed}");
    let deadline = tokio::time::Instant::now() + WAIT;
    while !agents.sent(&chat).iter().any(|s| s.contains("then this")) && tokio::time::Instant::now() < deadline {
        frames.next(Duration::from_millis(200)).await;
    }
    let sent = agents.sent(&chat);
    let prompts: Vec<Option<String>> = agents.started().iter().map(|s| s.prompt.clone()).collect();
    let (_, queue) = rig::call(&app, Method::Get, &format!("/workers/{chat}/queue"), None).await;
    let (_, row) = rig::call(&app, Method::Get, &format!("/workers/{chat}"), None).await;
    println!("after resume the agent got {sent:?}; started with {prompts:?}; queue {queue}; state {}", row["state"]);
    assert_eq!(
        sent.iter().filter(|s| s.contains("then this")).count(),
        1,
        "the queued message went out once: {sent:?}"
    );
    app.shutdown(Duration::from_secs(5)).await;
}

/// A throwaway repository with one commit on `main`.
fn repository(dir: &std::path::Path) -> String {
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Flow")
            .env("GIT_AUTHOR_EMAIL", "flow@example.invalid")
            .env("GIT_COMMITTER_NAME", "Flow")
            .env("GIT_COMMITTER_EMAIL", "flow@example.invalid")
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("README.md"), "# project\n").expect("a file");
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "first"]);
    dir.canonicalize().expect("the folder").to_string_lossy().into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_orchestrator_runs_workers_that_consult_ask_report_and_are_integrated() {
    // The user asked to be asked before any web fetch.
    let mut b =
        Bench::with_files(&[("policy.yaml", "default: allow\nrules:\n  - { tool: WebFetch, action: ask }\n")]).await;
    let repo_dir = tempfile::tempdir().expect("a folder");
    let repo = repository(repo_dir.path());

    let (status, made) =
        b.call(Method::Post, "/orchestrators", Some(json!({"cwd": repo, "prompt": "[reply] plan it"}))).await;
    assert_eq!(status, 201, "{made}");
    let orch = made["id"].as_str().expect("an id").to_owned();
    b.until_state(&orch, "IDLE").await;

    // Two workers from a definition, each in a worktree of the repository, consulting each other.
    let mut workers = Vec::new();
    for name in ["alpha", "beta"] {
        let spawn = json!({"parentId": orch, "from": "general-purpose", "prompt": format!("[reply] part {name}"),
            "worktreeFrom": repo, "name": name, "collaborate": true, "permissionMode": "acceptEdits"});
        let (status, made) = b.call(Method::Post, "/workers", Some(spawn)).await;
        assert!(status < 300, "{status} {made}");
        let id = made["id"].as_str().expect("an id").to_owned();
        b.until_state(&id, "IDLE").await;
        let (_, row) = b.row(&id).await;
        assert_eq!(row["parent_id"], orch.as_str(), "{row}");
        assert_eq!(row["worker_definition"], "general-purpose", "{row}");
        let dir = row["worktree_dir"].as_str().expect("a worktree").to_owned();
        assert!(std::path::Path::new(&dir).join("README.md").exists(), "the worktree holds the repository");
        workers.push((id, dir));
    }
    let (alpha, alpha_dir) = workers[0].clone();
    let (beta, _) = workers[1].clone();

    // alpha asks beta; beta gets the question as a turn and answers.
    let ask = json!({"target": {"name": "beta"}, "question": "Which file do you own?"});
    let (status, asked) = b.call(Method::Post, &format!("/workers/{alpha}/peer-request"), Some(ask)).await;
    assert_eq!(status, 200, "{asked}");
    let request = asked["requestId"].as_str().expect("registered").to_owned();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !b.agents.sent(&beta).iter().any(|s| s.contains("Which file do you own?"))
        && tokio::time::Instant::now() < deadline
    {
        b.frames.next(Duration::from_millis(200)).await;
    }
    assert!(
        b.agents.sent(&beta).iter().any(|s| s.contains("Which file do you own?")),
        "beta was asked: {:?}",
        b.agents.sent(&beta)
    );
    let (status, answered) =
        b.call(Method::Post, &format!("/workers/{beta}/peer-response"), Some(json!({"answer": "src/beta.rs"}))).await;
    assert_eq!(status, 200, "{answered}");
    let (_, poll) = b.call(Method::Get, &format!("/workers/{alpha}/peer-request/{request}"), None).await;
    assert_eq!(poll, json!({"status": "answered", "answer": "src/beta.rs"}));

    // alpha's web fetch waits for the user, who allows it.
    let decide = json!({"worker_id": alpha, "tool_name": "WebFetch", "tool_use_id": "call_fetch",
        "input": {"url": "https://example.invalid/spec", "prompt": "read it"}});
    let router = b.app.router();
    let caller = b.app.callers().classify(None);
    let waiting = tokio::spawn(async move {
        let request = Request::new(Method::Post, "/policy/decide", caller)
            .header("content-type", "application/json")
            .body(decide.to_string());
        let response = router.handle(request).await;
        let bytes = response.body.collect().await.unwrap_or_default();
        serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)
    });
    let created = b.frames.until(WAIT, |f| f["reason"] == "pending:created").await.expect("the ask is announced");
    let pending =
        created["payload"]["id"].as_str().or_else(|| created["payload"]["pendingId"].as_str()).map(str::to_owned);
    let pending = match pending {
        Some(id) => id,
        None => {
            let (_, list) = b.call(Method::Get, "/pending", None).await;
            list.as_array().and_then(|l| l.first()).and_then(|p| p["id"].as_str()).expect("a pending ask").to_owned()
        }
    };
    let (status, _) =
        b.call(Method::Post, &format!("/pending/{pending}/decision"), Some(json!({"decision": "allow"}))).await;
    assert_eq!(status, 200);
    let verdict = tokio::time::timeout(WAIT, waiting).await.expect("answered in time").expect("the call");
    assert_eq!(verdict["behavior"], "allow", "{verdict}");

    // alpha does the work in its worktree, reports, and the orchestrator hears of it as a turn.
    std::fs::write(std::path::Path::new(&alpha_dir).join("alpha.txt"), "alpha's part\n").expect("a file");
    let (status, reported) = b
        .call(
            Method::Post,
            &format!("/workers/{alpha}/report"),
            Some(json!({"text": "Part alpha is done in alpha.txt."})),
        )
        .await;
    assert_eq!(status, 200, "{reported}");
    let deadline = tokio::time::Instant::now() + WAIT;
    while !b.agents.sent(&orch).iter().any(|s| s.contains("Part alpha is done"))
        && tokio::time::Instant::now() < deadline
    {
        b.frames.next(Duration::from_millis(200)).await;
    }
    let heard = b.agents.sent(&orch);
    assert!(heard.iter().any(|s| s.contains("Part alpha is done")), "the orchestrator got the report: {heard:?}");
    let rows = b.rows(&orch).await;
    let report = of_type(&rows, "worker_report").into_iter().map(payload).find(|p| p["fromWorker"] == alpha.as_str());
    let report = report.expect("the report is in the orchestrator's log");
    assert_eq!(
        (report["text"].as_str(), report["workerName"].as_str()),
        (Some("Part alpha is done in alpha.txt."), Some("alpha"))
    );

    // The orchestrator integrates alpha's branch into the repository.
    let (status, integrated) =
        b.call(Method::Post, &format!("/orchestrators/{orch}/integrate"), Some(json!({"ids": [alpha]}))).await;
    assert_eq!(status, 200, "{integrated}");
    let results = integrated["workers"].as_array().cloned().unwrap_or_default();
    let mine = results.iter().find(|r| r["workerId"] == alpha.as_str()).cloned().unwrap_or(Value::Null);
    assert_eq!(mine["outcome"], "merged", "{integrated}");
    assert!(std::path::Path::new(&repo).join("alpha.txt").exists(), "alpha's file is in the repository now");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_goal_loop_is_refused_and_one_on_record_holds_nothing_back() {
    // The TypeScript app's config.json may switch goal loops on: this app has none.
    let mut b = Bench::with_files(&[("config.json", r#"{"loop": {"enabled": true}}"#)]).await;
    let repo_dir = tempfile::tempdir().expect("a folder");
    let repo = repository(repo_dir.path());
    let (status, made) =
        b.call(Method::Post, "/orchestrators", Some(json!({"cwd": repo, "prompt": "[reply] plan it"}))).await;
    assert_eq!(status, 201, "{made}");
    let orch = made["id"].as_str().expect("an id").to_owned();
    b.until_state(&orch, "IDLE").await;

    let goal = json!({"summary": "write done.txt", "criteria": [{"id": "c1", "text": "done.txt exists", "verify": "test -f done.txt"}]});
    let mut spawn = json!({"parentId": orch, "from": "general-purpose", "prompt": "[reply] start", "worktreeFrom": repo,
        "name": "worker", "loop": {"goal": goal, "strategy": "command", "limit": 5}});
    let refused = b.call(Method::Post, "/workers", Some(spawn.clone())).await;
    assert_eq!(refused, (400, json!({"error": "goal loops are not available — spawn the worker without `loop`"})));
    let (status, _) =
        b.call(Method::Post, &format!("/orchestrators/{orch}/loop"), Some(json!({"op": "attach", "goal": goal}))).await;
    assert_eq!(status, 404, "the loop routes are not served");

    if let Some(fields) = spawn.as_object_mut() {
        fields.remove("loop");
    }
    let (status, made) = b.call(Method::Post, "/workers", Some(spawn)).await;
    assert_eq!(status, 201, "{made}");
    let worker = made["id"].as_str().expect("an id").to_owned();
    b.until_state(&worker, "IDLE").await;
    // An active goal loop on record for it, as the TypeScript app leaves one in the data folder.
    let db = rusqlite::Connection::open(b.home.join("state.db")).expect("the database");
    db.busy_timeout(WAIT).expect("a timeout");
    db.execute(
        "INSERT INTO worker_loops (id, worker_id, parent_id, goal_json, strategy, status, started_at, updated_at) \
         VALUES ('l-OLD', ?1, ?2, ?3, 'command', 'active', 1, 1)",
        rusqlite::params![worker, orch, goal.to_string()],
    )
    .expect("a loop on record");
    let prompts = b.agents.sent(&worker).len();

    // Its report reaches the orchestrator as a turn; nothing checks a goal or sends the worker back.
    let reported =
        b.call(Method::Post, &format!("/workers/{worker}/report"), Some(json!({"text": "result: done"}))).await;
    assert_eq!(reported, (200, json!({"ok": true, "delivered": true})));
    let deadline = tokio::time::Instant::now() + WAIT;
    while !b.agents.sent(&orch).iter().any(|s| s.contains("result: done")) && tokio::time::Instant::now() < deadline {
        b.frames.next(Duration::from_millis(200)).await;
    }
    assert!(b.agents.sent(&orch).iter().any(|s| s.contains("result: done")), "the orchestrator got the report");
    let (_, row) = b.row(&worker).await;
    assert!(row.get("loop").is_none(), "{row}");
    assert_eq!(b.agents.sent(&worker).len(), prompts, "nothing sent it back: {:?}", b.agents.sent(&worker));
}
