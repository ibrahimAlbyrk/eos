//! The services over fakes: terminals the test speaks for, transcripts it
//! writes, commands it ends (`manager/services/__tests__/PtySessionService`,
//! `PtyConversationService`, `TerminalRunService`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{PtyCreateRequest, PtyCreateRequestClaude, PtyKind, PtyPendingName, WorkerEventType};
use eos_core::Error;
use eos_domain::claude_transcript::transcript_view;
use eos_runtime::bus::Filter;
use eos_runtime::jobs::JobStatus;
use eos_runtime::{Kernel, KernelOptions};
use eos_testkit::{
    FakeClaudeEnv, FakeClaudeProgram, FakeClock, FakeShellCommands, FakeTerminals, FakeTranscripts, SeqIds, TempStore,
};
use serde_json::{Value, json};

use crate::conversation::Conversations;
use crate::deliver::deliver_prompt;
use crate::runs::{RunDeps, Runs};
use crate::sessions::{CLAUDE_MISSING, SessionDeps, Sessions};

struct Harness {
    kernel: Kernel,
    clock: Arc<FakeClock>,
    terminals: Arc<FakeTerminals>,
    transcripts: Arc<FakeTranscripts>,
    sessions: Sessions,
    conversations: Conversations,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Harness {
    fn new() -> Self {
        Self::with_claude(Some("claude"))
    }

    fn with_claude(claude: Option<&str>) -> Self {
        let clock = Arc::new(FakeClock::new());
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
        let terminals = Arc::new(FakeTerminals::new());
        let transcripts = Arc::new(FakeTranscripts::new());
        let sessions = Sessions::new(SessionDeps {
            terminals: terminals.clone(),
            claude: Arc::new(FakeClaudeProgram(claude.map(str::to_owned))),
            claude_env: Arc::new(FakeClaudeEnv(Some(vec![("CLAUDE_STORE".to_owned(), "/store".to_owned())]))),
            bus: kernel.bus.clone(),
            ids: Arc::new(SeqIds::new()),
            clock: clock.clone(),
            default_cwd: "/home/me".to_owned(),
        });
        let conversations = Conversations::new(kernel.bus.clone(), sessions.clone(), transcripts.clone());
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        kernel
            .bus
            .on(Filter::All, move |event| {
                let payload = serde_json::from_slice(&event.payload).unwrap_or(Value::Null);
                seen.lock().expect("events").push((event.topic.to_string(), payload));
            })
            .forever();
        Self { kernel, clock, terminals, transcripts, sessions, conversations, events }
    }

    /// Everything published so far, delivered.
    async fn events(&self) -> Vec<(String, Value)> {
        self.kernel.bus.flush().await;
        self.events.lock().expect("events").clone()
    }

    async fn of(&self, topic: &str) -> Vec<Value> {
        self.events().await.into_iter().filter(|(t, _)| t == topic).map(|(_, p)| p).collect()
    }

    async fn shell(&self) -> String {
        self.sessions.create(request(80, 24)).await.expect("a session").session_id
    }

    async fn claude(&self) -> String {
        let req = PtyCreateRequest { claude: Some(PtyCreateRequestClaude { resume: None }), ..request(80, 24) };
        self.sessions.create(req).await.expect("a session").session_id
    }
}

fn request(cols: i64, rows: i64) -> PtyCreateRequest {
    PtyCreateRequest { cols, rows, cwd: None, command: None, claude: None, remote: None, owner: None }
}

// ---- sessions ---------------------------------------------------------------

#[tokio::test]
async fn a_session_starts_in_the_default_folder_and_is_announced() {
    let h = Harness::new();
    let session = h.sessions.create(request(80, 24)).await.expect("a session");
    assert_eq!(
        serde_json::to_value(&session).expect("json"),
        json!({
            "sessionId": "00000000-0000-4000-8000-000000000001", "number": 1, "cwd": "/home/me", "cols": 80, "rows": 24,
            "alive": true, "kind": "shell", "claudeSessionId": null, "title": null, "remote": false, "owner": null,
        })
    );
    let spec = h.terminals.last().spec.clone();
    assert_eq!((spec.cwd.as_str(), spec.cols, spec.rows, spec.command, spec.env), ("/home/me", 80, 24, None, None));
    assert_eq!(h.of("pty:session").await, [serde_json::to_value(&session).expect("json")]);
    assert_eq!(h.sessions.list(), std::slice::from_ref(&session));
    assert_eq!(h.sessions.get(&session.session_id), Some(session));
}

#[tokio::test]
async fn a_folder_a_first_command_and_who_opened_it_pass_through() {
    let h = Harness::new();
    let req = PtyCreateRequest {
        cwd: Some("/work".into()),
        command: Some("npm test".into()),
        remote: Some(true),
        owner: Some("phone-1".into()),
        ..request(100, 30)
    };
    let session = h.sessions.create(req).await.expect("a session");
    assert_eq!((session.cwd.as_str(), session.remote, session.owner.as_deref()), ("/work", true, Some("phone-1")));
    assert_eq!(h.terminals.last().spec.command.as_deref(), Some("npm test"));
}

#[tokio::test]
async fn tab_numbers_climb_while_any_tab_is_open_and_start_over_when_none_is() {
    let h = Harness::new();
    let number = |id: &str| h.sessions.get(id).expect("the session").number;
    let (a, b) = (h.shell().await, h.shell().await);
    assert_eq!((number(&a), number(&b)), (1, 2));
    h.terminals.ptys()[0].exit(0);
    let c = h.shell().await;
    assert_eq!(number(&c), 3, "never reused while a tab remains");
    h.terminals.ptys()[1].exit(0);
    h.terminals.ptys()[2].exit(0);
    assert!(h.sessions.list().is_empty());
    let d = h.shell().await;
    assert_eq!(number(&d), 1, "from zero tabs it is Terminal 1 again");
}

#[tokio::test]
async fn sessions_are_capped_at_32() {
    let h = Harness::new();
    for _ in 0..32 {
        h.shell().await;
    }
    let refused = h.sessions.create(request(80, 24)).await;
    assert_eq!(refused, Err(Error::LimitExceeded("too many terminal sessions (max 32)".into())));
    assert_eq!(h.terminals.ptys().len(), 32);
}

#[tokio::test(start_paused = true)]
async fn the_first_output_goes_at_once_and_what_follows_within_a_frame_is_joined() {
    let h = Harness::new();
    let id = h.shell().await;
    let pty = h.terminals.last();
    let seq = || h.sessions.buffer(&id).expect("the session").0;

    pty.emit("$ ");
    assert_eq!(seq(), 1, "the prompt is not held back");
    pty.emit("l");
    pty.emit("s");
    assert_eq!(seq(), 1, "inside the window output only gathers");
    tokio::time::sleep(Duration::from_millis(17)).await;
    assert_eq!(seq(), 2);
    // The window closed with nothing left: the next byte is a first byte again.
    tokio::time::sleep(Duration::from_millis(40)).await;
    pty.emit("x");
    assert_eq!(seq(), 3);

    let frames = h.of("pty:data").await;
    assert_eq!(
        frames,
        [
            json!({ "sessionId": id, "number": 1, "seq": 1, "data": "$ " }),
            json!({ "sessionId": id, "number": 1, "seq": 2, "data": "ls" }),
            json!({ "sessionId": id, "number": 1, "seq": 3, "data": "x" }),
        ]
    );
    // The mirror was fed exactly what was published.
    assert_eq!(h.sessions.buffer(&id), Some((3, "80x24:$ lsx".to_owned())));
}

#[tokio::test(start_paused = true)]
async fn a_burst_is_cut_every_8_kilobytes_without_waiting() {
    let h = Harness::new();
    let id = h.shell().await;
    let pty = h.terminals.last();
    pty.emit("first");
    pty.emit(&"x".repeat(5000));
    assert_eq!(h.sessions.buffer(&id).expect("the session").0, 1);
    pty.emit(&"y".repeat(5000));
    assert_eq!(h.sessions.buffer(&id).expect("the session").0, 2, "past 8 KB it goes at once");
    let frames = h.of("pty:data").await;
    assert_eq!(frames[1]["data"].as_str().map(str::len), Some(10_000));
}

#[tokio::test(start_paused = true)]
async fn what_the_window_holds_goes_out_ahead_of_the_exit() {
    let h = Harness::new();
    let id = h.shell().await;
    let pty = h.terminals.last();
    pty.emit("a");
    pty.emit("bye");
    pty.exit(3);
    let events: Vec<(String, Value)> = h.events().await.into_iter().filter(|(t, _)| t != "pty:session").collect();
    assert_eq!(
        events,
        [
            ("pty:data".to_owned(), json!({ "sessionId": id, "number": 1, "seq": 1, "data": "a" })),
            ("pty:data".to_owned(), json!({ "sessionId": id, "number": 1, "seq": 2, "data": "bye" })),
            ("pty:exit".to_owned(), json!({ "sessionId": id, "number": 1, "exitCode": 3 })),
        ]
    );
    assert_eq!(h.sessions.get(&id), None);
    // Nothing fires for it afterwards.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(h.of("pty:data").await.len(), 2);
}

#[tokio::test]
async fn input_resize_and_kill_reach_the_terminal() {
    let h = Harness::new();
    let id = h.shell().await;
    let pty = h.terminals.last();
    assert!(h.sessions.input(&id, "ls\r"));
    assert_eq!(pty.written(), ["ls\r"]);

    assert!(h.sessions.resize(&id, 100, 30));
    assert!(h.sessions.resize(&id, 100, 30));
    assert_eq!(pty.sizes(), [(100, 30), (100, 30)]);
    assert_eq!(h.sessions.buffer(&id), Some((0, "100x30:".to_owned())), "the mirror follows");
    let announced = h.of("pty:session").await;
    assert_eq!(announced.len(), 2, "created, and one real resize: the same size again says nothing");
    assert_eq!((announced[1]["cols"].clone(), announced[1]["rows"].clone()), (json!(100), json!(30)));

    assert!(h.sessions.kill(&id));
    assert_eq!(pty.kills(), 1);
    assert!(h.sessions.get(&id).is_some(), "the session goes when its shell does");
}

#[tokio::test]
async fn an_unknown_session_is_absent_not_an_error() {
    let h = Harness::new();
    assert!(!h.sessions.input("nope", "x"));
    assert!(!h.sessions.input_in_order("nope", "s", 1, "x"));
    assert!(!h.sessions.resize("nope", 1, 1));
    assert!(!h.sessions.kill("nope"));
    assert_eq!(h.sessions.buffer("nope"), None);
    assert_eq!(h.sessions.foreground("nope").await, None);
    assert!(!h.sessions.send_steps("nope", &["x".to_owned()]).await);
}

#[tokio::test(start_paused = true)]
async fn numbered_input_is_written_in_its_order() {
    let h = Harness::new();
    let id = h.shell().await;
    assert!(h.sessions.input_in_order(&id, "phone-1", 2, "b"));
    assert!(h.sessions.input_in_order(&id, "phone-1", 1, "a"));
    assert!(h.sessions.input_in_order(&id, "phone-1", 3, "c"));
    assert_eq!(h.terminals.last().written(), ["a", "b", "c"]);
}

#[tokio::test(start_paused = true)]
async fn steps_are_written_one_at_a_time_and_two_sequences_never_interleave() {
    let h = Harness::new();
    let id = h.shell().await;
    let first = ["\x1b[200~hello\x1b[201~".to_owned(), "\r".to_owned()];
    let second = ["1".to_owned(), "2".to_owned()];
    let started = tokio::time::Instant::now();
    let (a, b) = tokio::join!(h.sessions.send_steps(&id, &first), h.sessions.send_steps(&id, &second));
    assert!(a && b);
    assert_eq!(h.terminals.last().written(), ["\x1b[200~hello\x1b[201~", "\r", "1", "2"]);
    // A paste is given 300 ms to land, a key 150.
    assert_eq!(started.elapsed(), Duration::from_millis(300 + 150 + 150 + 150));
}

#[tokio::test]
async fn a_claude_pane_runs_the_users_claude_under_a_pinned_conversation() {
    let h = Harness::new();
    let id = h.claude().await;
    let session = h.sessions.get(&id).expect("the session");
    let conversation = session.claude_session_id.clone().expect("a pinned conversation");
    assert_eq!(session.kind, PtyKind::Claude);
    let spec = h.terminals.last().spec.clone();
    let command = spec.command.expect("a command");
    assert!(command.starts_with("EOS_TTY=$(tty) claude --model opus --dangerously-skip-permissions --session-id "));
    assert!(command.contains(&conversation) && command.contains("--settings '{\"hooks\""));
    assert_eq!(spec.env, Some(vec![("CLAUDE_STORE".to_owned(), "/store".to_owned())]), "Claude gets Eos's sign-in");

    // Resuming tries the conversation first and starts it fresh if it never got a message.
    let resume = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
    let req =
        PtyCreateRequest { claude: Some(PtyCreateRequestClaude { resume: Some(resume.into()) }), ..request(80, 24) };
    let resumed = h.sessions.create(req).await.expect("a session");
    assert_eq!(resumed.claude_session_id.as_deref(), Some(resume));
    let command = h.terminals.last().spec.command.clone().expect("a command");
    assert!(
        command.contains(&format!("--resume {resume} --settings"))
            && command.contains(&format!(
                "' || EOS_TTY=$(tty) claude --model opus --dangerously-skip-permissions --session-id {resume} "
            ))
    );
}

#[tokio::test]
async fn a_claude_pane_without_claude_installed_says_so_and_starts_nothing() {
    let h = Harness::with_claude(None);
    let req = PtyCreateRequest { claude: Some(PtyCreateRequestClaude { resume: None }), ..request(80, 24) };
    assert_eq!(h.sessions.create(req).await, Err(Error::Conflict(CLAUDE_MISSING.to_owned())));
    assert!(h.terminals.ptys().is_empty() && h.sessions.list().is_empty());
    // A plain shell does not need it.
    h.shell().await;
}

#[tokio::test]
async fn a_pane_s_title_and_conversation_follow_its_output() {
    let h = Harness::new();
    let id = h.claude().await;
    let pty = h.terminals.last();
    let moved = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
    pty.emit("\x1b]0;✳ Fix login\x07");
    pty.emit(&format!("\x1b]7777;eos-claude-session={moved}\x07"));
    pty.emit("\x1b]0;✳ Fix login\x07");
    let session = h.sessions.get(&id).expect("the session");
    assert_eq!((session.title.as_deref(), session.claude_session_id.as_deref()), (Some("Fix login"), Some(moved)));
    assert_eq!(h.of("pty:session").await.len(), 3, "created, titled, moved; the same title again says nothing");
}

#[tokio::test]
async fn a_reported_dialog_is_remembered_and_announced() {
    let h = Harness::new();
    let id = h.claude().await;
    let hook = json!({ "tool_name": "AskUserQuestion", "tool_use_id": "toolu_1", "tool_input": { "questions": [] } });
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hook.to_string());
    h.clock.set(5_000);
    h.terminals.last().emit(&format!("\x1b]7777;eos-claude-tool={encoded}\x07"));
    let dialog = h.sessions.dialog_call(&id).expect("the dialog");
    assert_eq!(
        (dialog.call.tool_use_id.as_str(), dialog.call.name, dialog.at),
        ("toolu_1", PtyPendingName::AskUserQuestion, 5_000)
    );
    let conversation = h.sessions.get(&id).expect("the session").claude_session_id;
    assert_eq!(h.of("pty:conversation").await, [json!({ "sessionId": id, "claudeSessionId": conversation })]);
}

#[tokio::test]
async fn closing_the_app_lets_go_of_every_terminal() {
    let h = Harness::new();
    h.shell().await;
    h.shell().await;
    let ptys = h.terminals.ptys();
    h.sessions.shutdown();
    assert!(h.sessions.list().is_empty());
    // (a handler still at work on an earlier event holds the services for a moment)
    h.kernel.bus.flush().await;
    drop(h);
    // Nothing but the test holds them: a real terminal ends its shell here.
    assert!(ptys.iter().all(|pty| Arc::strong_count(pty) == 1));
}

// ---- conversations ----------------------------------------------------------

fn line(uuid: &str, parent: Option<&str>, kind: &str, content: Value, stop: Option<&str>) -> String {
    let mut message = json!({ "role": kind, "content": content });
    if kind == "assistant" {
        message["stop_reason"] = json!(stop);
    }
    json!({ "type": kind, "uuid": uuid, "parentUuid": parent, "timestamp": "2026-09-27T10:00:00.000Z", "message": message })
        .to_string()
        + "\n"
}

#[tokio::test(start_paused = true)]
async fn a_claude_panes_conversation_is_its_transcript_and_changes_are_announced() {
    let h = Harness::new();
    let id = h.claude().await;
    let conversation = h.sessions.get(&id).expect("the session").claude_session_id.expect("pinned");

    let empty = h.conversations.get(&id).await.expect("a claude pane");
    assert_eq!((empty.claude_session_id.as_deref(), empty.view.rows.len()), (Some(conversation.as_str()), 0));
    assert_eq!(h.conversations.watching(), 1);

    let mut jsonl = line("u1", None, "user", json!("hello"), None);
    h.transcripts.set("/home/me", &conversation, transcript_view(&jsonl, false));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(h.of("pty:conversation").await, [json!({ "sessionId": id, "claudeSessionId": conversation })]);
    let read = h.conversations.get(&id).await.expect("a claude pane");
    assert_eq!(read.view.rows.len(), 1);
    assert!(read.view.running);

    jsonl += &line("u2", Some("u1"), "assistant", json!([{ "type": "text", "text": "hi" }]), Some("end_turn"));
    h.transcripts.set("/home/me", &conversation, transcript_view(&jsonl, false));
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(h.of("pty:conversation").await.len(), 2);
    assert_eq!(h.conversations.get(&id).await.expect("a claude pane").view.rows.len(), 2);

    // Unchanged: nothing is said.
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(h.of("pty:conversation").await.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn the_watch_follows_the_pane_to_a_new_conversation_and_ends_with_it() {
    let h = Harness::new();
    let id = h.claude().await;
    h.conversations.get(&id).await.expect("a claude pane");
    assert_eq!(h.conversations.watching(), 1);

    let moved = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
    h.terminals.last().emit(&format!("\x1b]7777;eos-claude-session={moved}\x07"));
    assert_eq!(h.of("pty:conversation").await, [json!({ "sessionId": id, "claudeSessionId": moved })]);
    assert_eq!(h.conversations.watching(), 0, "the old conversation is no longer watched");
    assert_eq!(h.conversations.get(&id).await.expect("a claude pane").claude_session_id.as_deref(), Some(moved));
    assert_eq!(h.conversations.watching(), 1);

    h.terminals.last().exit(0);
    h.kernel.bus.flush().await;
    assert_eq!(h.conversations.watching(), 0);
    assert_eq!(h.conversations.get(&id).await, None);
}

#[tokio::test(start_paused = true)]
async fn a_reported_question_shows_until_the_transcript_settles_it() {
    let h = Harness::new();
    let id = h.claude().await;
    let conversation = h.sessions.get(&id).expect("the session").claude_session_id.expect("pinned");
    let ask = json!({ "questions": [{ "question": "Which?", "options": [{ "label": "A" }] }] });
    let hook = json!({ "tool_name": "AskUserQuestion", "tool_use_id": "q1", "tool_input": ask });
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hook.to_string());
    // The dialog opened after the prompt was recorded (10:00:00).
    h.clock.set(1_790_503_260_000);
    h.terminals.last().emit(&format!("\x1b]7777;eos-claude-tool={encoded}\x07"));

    // Claude writes the call to its transcript only once it is answered.
    let mut jsonl = line("u1", None, "user", json!("ask me"), None);
    h.transcripts.set("/home/me", &conversation, transcript_view(&jsonl, false));
    let pending = h.conversations.get(&id).await.expect("a claude pane").view.pending.expect("the reported question");
    assert_eq!((pending.tool_use_id.as_str(), pending.name), ("q1", PtyPendingName::AskUserQuestion));

    jsonl += &line(
        "u2",
        Some("u1"),
        "assistant",
        json!([{ "type": "tool_use", "id": "q1", "name": "AskUserQuestion", "input": ask }]),
        Some("tool_use"),
    );
    jsonl +=
        &line("u3", Some("u2"), "user", json!([{ "type": "tool_result", "tool_use_id": "q1", "content": "A" }]), None);
    h.transcripts.set("/home/me", &conversation, transcript_view(&jsonl, false));
    assert_eq!(h.conversations.get(&id).await.expect("a claude pane").view.pending, None, "its result settles it");
}

#[tokio::test(start_paused = true)]
async fn a_reported_question_stays_behind_when_the_pane_moves_to_another_conversation() {
    let h = Harness::new();
    let id = h.claude().await;
    let hook = json!({ "tool_name": "ExitPlanMode", "tool_use_id": "p1", "tool_input": { "plan": "x" } });
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, hook.to_string());
    h.terminals.last().emit(&format!("\x1b]7777;eos-claude-tool={encoded}\x07"));
    assert!(h.conversations.get(&id).await.expect("a claude pane").view.pending.is_some());
    // `/clear`: a new conversation, in which nobody asked anything.
    h.terminals.last().emit("\x1b]7777;eos-claude-session=0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b\x07");
    assert_eq!(h.conversations.get(&id).await.expect("a claude pane").view.pending, None);
}

#[tokio::test]
async fn a_shell_pane_has_no_conversation() {
    let h = Harness::new();
    let id = h.shell().await;
    assert_eq!(h.conversations.get(&id).await, None);
    assert_eq!(h.conversations.get("nope").await, None);
}

// ---- delivering a prompt ----------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_prompt_to_an_idle_claude_gets_enter_again_if_it_was_not_recorded() {
    let h = Harness::new();
    let id = h.claude().await;
    let conversation = h.sessions.get(&id).expect("the session").claude_session_id.expect("pinned");
    let pty = h.terminals.last();

    // Dropped Enter: nothing reaches the transcript, so Enter goes once more.
    assert!(deliver_prompt(&h.sessions, &h.conversations, &id, "do it").await);
    assert_eq!(pty.written(), ["\x1b[200~do it\x1b[201~", "\r", "\r"]);

    // Recorded in time: no second Enter.
    let (sessions, conversations, pane) = (h.sessions.clone(), h.conversations.clone(), id.clone());
    let delivery = tokio::spawn(async move { deliver_prompt(&sessions, &conversations, &pane, "again").await });
    tokio::time::sleep(Duration::from_millis(700)).await;
    h.transcripts.set(
        "/home/me",
        &conversation,
        transcript_view(&line("u1", None, "user", json!("again"), None), false),
    );
    assert!(delivery.await.expect("delivered"));
    assert_eq!(pty.written().len(), 5);

    // Mid-turn Claude queues the prompt and records it later: nothing to wait for.
    let started = tokio::time::Instant::now();
    assert!(deliver_prompt(&h.sessions, &h.conversations, &id, "queued").await);
    assert_eq!(started.elapsed(), Duration::from_millis(450));
    assert_eq!(pty.written().len(), 7);
}

// ---- `!` commands -----------------------------------------------------------

struct RunHarness {
    kernel: Kernel,
    temp: TempStore,
    commands: Arc<FakeShellCommands>,
    runs: Runs,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl RunHarness {
    fn new() -> Self {
        let clock = Arc::new(FakeClock::new());
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
        let temp = TempStore::seeded("/sandbox");
        let commands = Arc::new(FakeShellCommands::new());
        let runs = Runs::new(RunDeps {
            commands: commands.clone(),
            store: temp.port(),
            bus: kernel.bus.clone(),
            jobs: kernel.jobs.clone(),
            clock,
            ids: Arc::new(SeqIds::new()),
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        kernel
            .bus
            .on(Filter::All, move |event| {
                let payload = serde_json::from_slice(&event.payload).unwrap_or(Value::Null);
                seen.lock().expect("events").push((event.topic.to_string(), payload));
            })
            .forever();
        Self { kernel, temp, commands, runs, events }
    }

    /// The `terminal` rows saved to a chat, oldest first.
    async fn terminal_rows(&self, worker_id: &'static str) -> Vec<Value> {
        let rows = self
            .temp
            .port()
            .read(move |tx| tx.events().list_by_type(worker_id, WorkerEventType::Terminal, None))
            .await
            .expect("rows");
        rows.iter().map(|r| serde_json::from_str(r.payload.as_deref().unwrap_or("null")).expect("json")).collect()
    }

    async fn terminal_events(&self) -> Vec<(String, Value)> {
        self.kernel.bus.flush().await;
        self.events.lock().expect("events").iter().filter(|(t, _)| t.starts_with("terminal:")).cloned().collect()
    }
}

const RUN_1: &str = "00000000-0000-4000-8000-000000000001";

#[tokio::test(start_paused = true)]
async fn a_command_in_a_folder_streams_and_saves_nothing() {
    let h = RunHarness::new();
    let id = h.runs.run(None, "/sandbox/beta", "echo wire; exit 3");
    assert_eq!(id, RUN_1);
    let run = h.commands.last();
    assert_eq!(
        (run.cwd.as_str(), run.command.as_str(), run.timeout),
        ("/sandbox/beta", "echo wire; exit 3", Duration::from_secs(600))
    );
    run.emit("wire\n\x1b[31mproblem\x1b[0m\n");
    run.exit(Some(3), None, false);

    assert_eq!(
        h.terminal_events().await,
        [
            (
                "terminal:start".to_owned(),
                json!({ "workerId": null, "runId": id, "command": "echo wire; exit 3", "startedAt": FakeClock::START_MS })
            ),
            (
                "terminal:chunk".to_owned(),
                json!({ "workerId": null, "runId": id, "command": "echo wire; exit 3", "data": "wire\nproblem\n" })
            ),
            ("terminal:done".to_owned(), json!({ "workerId": null, "runId": id, "exitCode": 3, "note": null })),
        ]
    );
    assert!(h.temp.announced.list().is_empty(), "no chat, no row");
    assert_eq!(h.runs.running(), 0);

    // The Jobs tab has it, with its output.
    let job = &h.kernel.jobs.list()[0];
    assert_eq!(
        (job.id.as_str(), job.kind.as_str(), job.status),
        (format!("shell:eos:run-{id}").as_str(), "shell", JobStatus::Failed)
    );
    assert_eq!(
        (job.detail.as_deref(), job.exit_code, job.has_output, job.can_stop),
        (Some("exit 3"), Some(3), true, false)
    );
    assert_eq!(h.kernel.jobs.output(&job.id, 0).expect("output").text, "wire\nproblem\n");
}

#[tokio::test(start_paused = true)]
async fn a_command_in_a_chat_leaves_one_row_and_says_the_chat_changed() {
    let h = RunHarness::new();
    let id = h.runs.run(Some("w-CHAT"), "/sandbox/alpha", "git status --short");
    let run = h.commands.last();
    run.emit(" M README.md\n");
    // Output inside the window is joined into one chunk.
    run.emit("?? notes.txt\n");
    tokio::time::sleep(Duration::from_millis(250)).await;
    run.exit(Some(0), None, false);
    h.kernel.bus.flush().await;

    let announced = loop {
        let announced = h.temp.announced.list();
        if !announced.is_empty() {
            break announced;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(
        announced,
        [
            ("terminal:done", json!({ "workerId": "w-CHAT", "runId": id, "exitCode": 0, "note": null }).to_string()),
            ("worker:change", json!({ "workerId": "w-CHAT" }).to_string()),
        ],
        "the end, then the chat's change, once the row is saved"
    );
    let chunks: Vec<Value> =
        h.terminal_events().await.into_iter().filter(|(t, _)| t == "terminal:chunk").map(|(_, p)| p).collect();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0]["data"], " M README.md\n?? notes.txt\n");

    // (the seeded chat already holds an older one)
    let row = h.terminal_rows("w-CHAT").await.pop().expect("the row");
    assert_eq!(
        row.to_string(),
        json!({
            "runId": id, "command": "git status --short", "cwd": "/sandbox/alpha", "output": " M README.md\n?? notes.txt\n",
            "exitCode": 0, "signal": null, "note": null, "truncated": false, "durationMs": 0,
        })
        .to_string(),
        "the row as today's, field for field"
    );
    assert_eq!(h.kernel.jobs.list()[0].status, JobStatus::Completed);
}

#[tokio::test(start_paused = true)]
async fn a_stop_ends_the_command_and_notes_it() {
    let h = RunHarness::new();
    let id = h.runs.run(None, "/sandbox/beta", "sleep 30");
    let run = h.commands.last();
    assert!(h.kernel.jobs.list()[0].can_stop);
    assert!(h.runs.kill(&id));
    assert_eq!(run.kills(), 1);
    run.exit(None, Some("SIGKILL"), false);
    let done = h.terminal_events().await.pop().expect("an end");
    assert_eq!(
        done,
        (
            "terminal:done".to_owned(),
            json!({ "workerId": null, "runId": id, "exitCode": 1, "note": "stopped by user" })
        )
    );
    let job = &h.kernel.jobs.list()[0];
    assert_eq!((job.status, job.detail.as_deref()), (JobStatus::Stopped, Some("stopped by user")));
    assert!(!h.runs.kill(&id), "already over");
    assert!(!h.runs.kill("nope"));
}

#[tokio::test(start_paused = true)]
async fn the_jobs_tab_stops_a_command_through_its_run() {
    let h = RunHarness::new();
    let id = h.runs.run(None, "/sandbox/beta", "sleep 30");
    let job_id = format!("shell:eos:run-{id}");
    assert_eq!(h.kernel.jobs.stop(&job_id).await, Ok(()));
    assert_eq!(h.commands.last().kills(), 1);
    h.commands.last().exit(None, Some("SIGKILL"), false);
    assert_eq!(h.kernel.jobs.stop(&job_id).await.map_err(|e| e.status), Err(404), "no running job any more");
}

#[tokio::test(start_paused = true)]
async fn a_command_that_runs_too_long_or_prints_too_much_is_ended_with_its_reason() {
    let h = RunHarness::new();
    let id = h.runs.run(None, "/sandbox/beta", "yes");
    let run = h.commands.last();
    let piece = "y\n".repeat(64 * 1024);
    for _ in 0..17 {
        run.emit(&piece);
    }
    assert_eq!(run.kills(), 1, "past 2 MB it is ended");
    run.exit(None, Some("SIGKILL"), false);
    let done = h.terminal_events().await.pop().expect("an end").1;
    assert_eq!((done["runId"].clone(), done["note"].clone()), (json!(id), json!("output limit exceeded (2MB)")));

    let late = h.runs.run(None, "/sandbox/beta", "sleep 9999");
    h.commands.last().exit(None, Some("SIGKILL"), true);
    let done = h.terminal_events().await.pop().expect("an end").1;
    assert_eq!(
        (done["runId"].clone(), done["note"].clone(), done["exitCode"].clone()),
        (json!(late), json!("timed out after 10m"), json!(1))
    );
}

#[tokio::test(start_paused = true)]
async fn a_command_that_cannot_start_ends_with_127_and_why() {
    let h = RunHarness::new();
    let id = h.runs.run(None, "/gone", "ls");
    h.commands.last().fail("no such folder");
    let done = h.terminal_events().await.pop().expect("an end");
    assert_eq!(
        done,
        (
            "terminal:done".to_owned(),
            json!({ "workerId": null, "runId": id, "exitCode": 127, "note": "bash spawn failed: no such folder" })
        )
    );
}

#[tokio::test(start_paused = true)]
async fn a_chats_row_keeps_the_first_256k_of_output_and_says_it_was_cut() {
    let h = RunHarness::new();
    h.runs.run(Some("w-CHAT"), "/sandbox/alpha", "cat big");
    let run = h.commands.last();
    for _ in 0..5 {
        run.emit(&"z".repeat(64 * 1024));
    }
    run.exit(Some(0), None, false);
    h.kernel.bus.flush().await;
    while h.temp.announced.list().is_empty() {
        tokio::task::yield_now().await;
    }
    let row = h.terminal_rows("w-CHAT").await.pop().expect("the row");
    assert_eq!((row["output"].as_str().map(str::len), row["truncated"].clone()), (Some(256 * 1024), json!(true)));
}
