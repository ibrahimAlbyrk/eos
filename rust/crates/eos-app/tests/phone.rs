//! A phone through the relay, end to end: the real relay connection and the
//! real gateway, a relay on a loopback port, a phone that speaks what the
//! released iOS app speaks, and the chat, transcript and terminal features
//! behind today's routes — with scripted agents and terminals the test
//! speaks for. Nothing here leaves this computer.

use std::sync::Arc;
use std::time::Duration;

use eos_core::Clock;
use eos_core::net::relay::Relay;
use eos_mod_agents::{AgentsModule, Spawning};
use eos_mod_remote::{GatewayOptions, RemoteModule, RemoteParts};
use eos_mod_terminals::{RunDeps, SessionDeps as TerminalDeps, TerminalsModule};
use eos_mod_workers::WorkersModule;
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_relay::{RelayClient, RelayOptions};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_sessions::{NoHooks, SessionDeps, Sessions};
use eos_store_files::prompts::LibraryPromptSource;
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_testkit::relay::{
    ControlAnswer, FakeKeepAwake, FakePhone, FakeRelay, FakeRemoteStore, JoinFailure, PHONE_CAPS,
};
use eos_testkit::{
    FakeClaudeEnv, FakeClaudeProgram, FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeScratch,
    FakeSettings, FakeShellCommands, FakeTerminals, FakeTranscripts, FakeWorktrees, ScriptedRuntime, SeqIds, TempStore,
    Turn,
};
use eos_workers::WorkerDefinitions;
use serde_json::{Value, json};

struct Mac {
    runtime: Runtime,
    relay: FakeRelay,
    remote: Arc<RemoteModule>,
    agents: ScriptedRuntime,
    terminals: Arc<FakeTerminals>,
    awake: Arc<FakeKeepAwake>,
    clock: Arc<FakeClock>,
    _temp: TempStore,
}

impl Mac {
    /// The app's chat, transcript and terminal routes with the phone link
    /// switched on, pointed at a relay on a loopback port.
    async fn start() -> Self {
        let relay = FakeRelay::start().await;
        let clock = Arc::new(FakeClock::at(1_790_000_500_000));
        let ids = Arc::new(SeqIds::new());
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
        let temp = TempStore::seeded_on_bus("/sandbox", &kernel.bus);
        let config =
            Arc::new(FakeConfig::new(json!({ "remote": { "enabled": true, "relay": { "url": relay.url() } } })));

        let agents = ScriptedRuntime::new();
        let library = Arc::new(LibraryPromptSource::with_overrides(Vec::new()));
        let spawning = Spawning {
            config: config.clone(),
            settings: Arc::new(FakeSettings::default()),
            prompts: Arc::new(PromptService::new(Arc::new(PromptRegistry::new(library)), tool_name_vars())),
            scratch: Arc::new(FakeScratch::default()),
        };
        let models = Arc::new(FakeModelCatalog::default());
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: clock.clone(),
            ids: ids.clone(),
            config: config.clone(),
            models: models.clone(),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: Arc::new(NoHooks),
            sleeper: Arc::new(eos_testkit::FakeSleeper::default()),
        });
        let files = Arc::new(FsWorkerDefinitionFiles::new(temp.home.path().join("workers")));
        let definitions = Arc::new(WorkerDefinitions::new(files, temp.port(), clock.clone()));
        let terminals = Arc::new(FakeTerminals::new());

        // The real connection to the relay, with pauses short enough for a test.
        let dialler = RelayClient::with_options(
            clock.clone(),
            RelayOptions {
                backoff_min: Duration::from_millis(40),
                ping_interval: Duration::from_secs(3600),
                ..RelayOptions::default()
            },
        );
        let awake = Arc::new(FakeKeepAwake::new());
        let remote = Arc::new(RemoteModule::new(RemoteParts {
            config: config.clone(),
            store: Arc::new(FakeRemoteStore::default()),
            relay: Some(Arc::new(dialler) as Arc<dyn Relay>),
            keep_awake: awake.clone(),
            kernel: kernel.clone(),
            clock: clock.clone(),
            ids: ids.clone(),
            options: GatewayOptions { patch_debounce: Duration::from_millis(10), ..GatewayOptions::default() },
        }));
        let modules: Vec<Arc<dyn Module>> = vec![
            Arc::new(AgentsModule::new(sessions, temp.port(), ids.clone(), definitions, spawning)),
            remote.clone(),
            Arc::new(TerminalsModule::new(
                TerminalDeps {
                    terminals: terminals.clone(),
                    claude: Arc::new(FakeClaudeProgram(None)),
                    claude_env: Arc::new(FakeClaudeEnv(None)),
                    bus: kernel.bus.clone(),
                    ids: ids.clone(),
                    clock: clock.clone(),
                    default_cwd: "/sandbox/alpha".to_owned(),
                },
                Arc::new(FakeTranscripts::new()),
                RunDeps {
                    commands: Arc::new(FakeShellCommands::new()),
                    store: temp.port(),
                    bus: kernel.bus.clone(),
                    jobs: kernel.jobs.clone(),
                    clock: clock.clone(),
                    ids,
                },
            )),
            Arc::new(WorkersModule::new(temp.port(), models)),
        ];
        let runtime = Runtime::build(kernel, modules, Arc::new(AllPluginsOn)).expect("composes");
        remote.attach_router(runtime.router.clone());
        runtime.lifecycle.start().await.expect("starts");
        // Armed: the room is registered before any phone tries to join it.
        for _ in 0..500 {
            if relay.room_count() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(relay.room_count(), 1, "the Mac registered its room");
        Self { runtime, relay, remote, agents, terminals, awake, clock, _temp: temp }
    }

    /// Settings › Remote shows the pairing code: the user's own dashboard asks for it.
    async fn pairing_code(&self) -> Value {
        let res = self.runtime.router.handle(Request::new(Method::Post, "/api/remote/pair", Caller::DASHBOARD)).await;
        assert_eq!(res.status, 200);
        serde_json::from_slice(&res.body.collect().await.expect("a body")).expect("a code")
    }

    fn now_s(&self) -> f64 {
        self.clock.now_ms() as f64 / 1000.0
    }

    async fn pair(&self) -> FakePhone {
        let code = self.pairing_code().await;
        let mut phone = FakePhone::pair(&code, self.now_s()).await.expect("the phone joins");
        // The app's first frame after the join-ack; the answer is the snapshot already under way.
        phone.hello(0, PHONE_CAPS);
        let _ = &mut phone;
        phone
    }
}

fn ids_of(rows: &Value) -> Vec<&str> {
    rows.as_array().expect("rows").iter().map(|row| row["id"].as_str().expect("an id")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_phone_pairs_reads_chats_follows_one_talks_to_an_agent_and_drives_a_terminal() {
    let mac = Mac::start().await;
    assert!(mac.remote.is_armed());
    assert_eq!(mac.awake.held(), 1, "the computer is kept awake while the link is armed");

    // ---- pair: scan the code, join the room ---------------------------------
    let code = mac.pairing_code().await;
    assert_eq!(
        (code["v"].as_i64(), code["typ"].as_str(), code["relay"].as_str()),
        (Some(3), Some("eos-pair"), Some(mac.relay.url().as_str()))
    );
    assert_eq!(code["exp"].as_i64(), Some(mac.clock.now_ms() / 1000 + 120), "shown for two minutes");
    let mut phone = mac.pair().await;
    let snapshot = phone.next_of("snapshot").await;
    assert_eq!(snapshot["caps"], json!(["focus", "rows", "deflate"]));
    assert!(ids_of(&snapshot["workers"]).contains(&"w-CHAT"), "seeded with the chat list");
    assert_eq!(snapshot["ptys"], json!([]), "and the terminal list, which the app would fetch next");
    assert_eq!(mac.remote.devices(), 1);

    // ---- list chats, open a transcript ----------------------------------------
    let listed = phone.get("/workers").await.ok();
    assert_eq!(listed, snapshot["workers"], "the list route answers what the snapshot carried");
    let transcript = phone.get("/workers/w-CHAT/events?limit=50&order=desc").await.ok();
    let rows = transcript.as_array().expect("rows");
    assert!(rows.len() > 1 && rows.iter().all(|row| row["worker_id"] == "w-CHAT"), "the chat's rows");
    assert!(phone.deflated() >= 1, "large frames travel packed for a phone that listed deflate");

    // What the phone may never reach, and what the user's own dashboard keeps to itself.
    for refused in ["/stream", "/api/remote/status", "/no/such/route"] {
        let answer = phone.get(refused).await;
        assert_eq!(
            answer,
            ControlAnswer::Error { code: "ROUTE_REFUSED".into(), message: "route not exposed remotely".into() },
            "{refused}"
        );
    }

    // ---- start a chat with an agent: a state patch and its rows follow ---------
    mac.agents.script(Turn::reply("Hello from the agent."));
    let created = phone
        .control(
            "POST",
            "/orchestrators",
            &json!({ "mode": "focused", "cwd": "/sandbox/alpha", "prompt": "Say hello" }).to_string(),
        )
        .await;
    let ControlAnswer::Reply { status: 201, body: created } = created else {
        panic!("the chat was not created: {created:?}")
    };
    let chat = created["id"].as_str().expect("an id").to_owned();
    let patch =
        phone.wait_for(|f| f["t"] == "patch" && f["resource"] == "workers" && f["data"]["id"] == chat.as_str()).await;
    assert_eq!(patch["op"], "upsert", "the new chat arrives as a row patch, in the list route's row shape");
    assert_eq!(patch["data"]["name"], "Say hello");
    mac.agents.settled().await;

    // The phone opens the chat: from now on its new rows are pushed.
    phone.focus(true, Some(&chat), Some(0), None);
    let rows = phone
        .wait_for(|f| {
            f["t"] == "rows" && f["workerId"] == chat.as_str() && !f["rows"].as_array().is_some_and(Vec::is_empty)
        })
        .await;
    let kinds: Vec<&str> =
        rows["rows"].as_array().expect("rows").iter().filter_map(|row| row["type"].as_str()).collect();
    assert!(kinds.contains(&"user_message"), "{kinds:?}");
    let newest =
        rows["rows"].as_array().expect("rows").iter().filter_map(|row| row["id"].as_i64()).max().expect("an id");

    // ---- send a message: the agent's answer is pushed as rows ------------------
    mac.agents.script(Turn::reply("Second answer."));
    let sent =
        phone.control("POST", &format!("/workers/{chat}/message"), &json!({ "text": "And again?" }).to_string()).await;
    assert!(matches!(sent, ControlAnswer::Reply { status: 200..=299, .. }), "{sent:?}");
    let mut pushed: Vec<Value> = Vec::new();
    let mut text = String::new();
    while !(text.contains("And again?") && text.contains("Second answer.")) {
        let frame = phone.wait_for(|f| f["t"] == "rows" && f["workerId"] == chat.as_str()).await;
        pushed.extend(frame["rows"].as_array().expect("rows").iter().cloned());
        text = serde_json::to_string(&pushed).expect("text");
    }
    assert!(pushed.iter().all(|row| row["id"].as_i64() > Some(newest)), "only rows the phone did not hold");
    let delivered = mac.agents.sent(&chat).pop().expect("a message for the agent");
    assert!(delivered.ends_with("And again?"), "the agent got the phone's words: {delivered}");

    // ---- drive a terminal -------------------------------------------------------
    let opened = phone.control("POST", "/pty", &json!({ "cols": 80, "rows": 24 }).to_string()).await.ok();
    let pty = opened["sessionId"].as_str().expect("a terminal").to_owned();
    phone.sub(&[&pty]);
    // Keystrokes go out without waiting for answers, and are written in that order.
    for key in ["l", "s", " ", "-", "l", "a", "\r"] {
        phone.control_no_reply("POST", &format!("/pty/{pty}/input"), &json!({ "data": key }).to_string());
    }
    let buffer = phone.get(&format!("/pty/{pty}/buffer")).await.ok();
    assert!(buffer["data"].is_string(), "the screen so far: {buffer}");
    let shell = mac.terminals.last();
    for _ in 0..500 {
        if shell.written().concat().ends_with('\r') {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(shell.written().concat(), "ls -la\r");
    shell.emit("total 0\r\n");
    let output = phone.wait_for(|f| f["reason"] == "pty:data").await;
    assert_eq!(
        (output["payload"]["sessionId"].as_str(), output["payload"]["data"].as_str()),
        (Some(pty.as_str()), Some("total 0\r\n"))
    );
    let listed = phone.get("/pty").await.ok();
    assert_eq!(listed["sessions"].as_array().map(Vec::len), Some(1));

    // ---- the audit log, and leaving ----------------------------------------------
    phone.close();
    for _ in 0..500 {
        if mac.remote.devices() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(mac.remote.devices(), 0, "the relay announces a phone that left");
    assert_eq!(mac.relay.push_intents(), 0, "the app asks the relay for no wake-up push");

    mac.runtime.shutdown(Duration::from_secs(5)).await;
    assert!(!mac.remote.is_armed());
    assert_eq!(mac.awake.held(), 0, "the computer may sleep again");
    for _ in 0..500 {
        if mac.relay.connections() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(mac.relay.connections(), 0, "the room is given up");
    mac.relay.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_code_a_wrong_bearer_and_a_dropped_relay_connection() {
    let mac = Mac::start().await;
    let code = mac.pairing_code().await;

    // A screenshot of the code, shown too late: the app refuses it before dialling.
    let late = FakePhone::pair(&code, mac.now_s() + 121.0).await.err();
    assert_eq!(late, Some(JoinFailure::Transient("Expired".into())));
    // A bearer the room does not list: the pairing is void.
    let room = code["room"].as_str().expect("a room");
    let stranger = FakePhone::join(&mac.relay.url(), room, &"x".repeat(43)).await.err();
    assert_eq!(stranger, Some(JoinFailure::AuthRejected));
    assert_eq!(mac.remote.devices(), 0);

    let mut phone = mac.pair().await;
    phone.next_of("snapshot").await;

    // The relay restarts: the Mac redials and registers again, the phone's
    // socket goes with the old connection, and the same code still pairs.
    mac.relay.drop_connections();
    phone.closed().await;
    let mut again = None;
    for _ in 0..200 {
        match FakePhone::pair(&code, mac.now_s()).await {
            Ok(phone) => {
                again = Some(phone);
                break;
            }
            Err(JoinFailure::Transient(_)) => tokio::time::sleep(Duration::from_millis(20)).await,
            Err(other) => panic!("the room's bearer changed: {other:?}"),
        }
    }
    let mut again = again.expect("the phone joins again once the Mac is back");
    let snapshot = again.next_of("snapshot").await;
    assert!(ids_of(&snapshot["workers"]).contains(&"w-CHAT"));
    assert_eq!(mac.remote.devices(), 1, "the old session went with the old connection");

    mac.runtime.shutdown(Duration::from_secs(5)).await;
    mac.relay.stop().await;
}

// ---- the composed app --------------------------------------------------------

mod composed {
    use std::sync::Arc;
    use std::time::Duration;

    use eos_app::{App, Options};
    use eos_core::net::relay::Relay;
    use eos_domain::config::Env;
    use eos_relay::{RelayClient, RelayOptions};
    use eos_runtime::http::{Method, Request};
    use eos_testkit::relay::{FakeKeepAwake, FakePhone, FakeRelay};
    use eos_testkit::{FakeClock, SeqIds, TempHome};
    use serde_json::{Value, json};

    async fn dashboard(app: &App, method: Method, target: &str) -> (u16, Value) {
        let caller = app.callers().classify(Some(app.callers().ui_token()));
        let res = app.router().handle(Request::new(method, target, caller)).await;
        let status = res.status;
        (status, serde_json::from_slice(&res.body.collect().await.expect("a body")).unwrap_or(Value::Null))
    }

    /// An app nobody handed a relay stays on this computer, even where the
    /// phone link is switched on (the default on a Mac): a test, a replay or
    /// a tool that opens a data folder dials nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_app_without_a_relay_never_dials_whatever_the_configuration_says() {
        let home = TempHome::new();
        let env = Env::new([("EOS_REMOTE_ENABLED".to_owned(), "1".to_owned())]);
        let options = Options {
            clock: Arc::new(FakeClock::new()),
            ids: Arc::new(SeqIds::new()),
            env,
            ..Options::new(home.path())
        };
        assert!(options.relay.is_none(), "nothing dials unless the binary says how");
        let app = App::build(options).expect("builds");
        app.start().await.expect("starts");
        let (_, status) = dashboard(&app, Method::Get, "/api/remote/status").await;
        assert_eq!((&status["enabled"], &status["armed"]), (&json!(true), &json!(false)));
        assert!(!app.remote().is_armed());
        assert!(!home.join("remote").exists(), "no room is minted for a link that is not armed");
        assert!(app.shutdown(Duration::from_secs(5)).await.clean());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_installed_app_arms_at_start_keeps_its_room_across_restarts_and_answers_a_phone() {
        let relay = FakeRelay::start().await;
        let home = TempHome::new();
        let awake = Arc::new(FakeKeepAwake::new());
        let build = || {
            let clock = Arc::new(FakeClock::new());
            let dialler = RelayClient::with_options(
                clock.clone(),
                RelayOptions { ping_interval: Duration::from_secs(3600), ..RelayOptions::default() },
            );
            let env = Env::new([
                ("EOS_REMOTE_ENABLED".to_owned(), "1".to_owned()),
                ("EOS_REMOTE_RELAY_URL".to_owned(), relay.url()),
            ]);
            App::build(Options {
                clock,
                ids: Arc::new(SeqIds::new()),
                env,
                relay: Some(Arc::new(dialler) as Arc<dyn Relay>),
                keep_awake: Some(awake.clone()),
                ..Options::new(home.path())
            })
            .expect("builds")
        };
        let app = build();
        app.start().await.expect("starts");
        assert!(app.remote().is_armed(), "switched on in the configuration: armed at start, as today");
        assert_eq!(awake.held(), 1, "kept awake while armed");
        let (status, code) = dashboard(&app, Method::Post, "/api/remote/pair").await;
        assert_eq!(status, 200);
        for name in ["room.id", "bearer.secret", "relay-owner.secret"] {
            assert!(home.join("remote").join(name).is_file(), "{name}");
        }
        assert_eq!(home.read("remote/room.id").trim(), code["room"].as_str().expect("a room"));

        // Through the whole app: the phone joins and is seeded by the real routes.
        let mut phone = None;
        for _ in 0..200 {
            match FakePhone::pair(&code, 0.0).await {
                Ok(joined) => {
                    phone = Some(joined);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        let mut phone = phone.expect("the phone joins");
        let snapshot = phone.next_of("snapshot").await;
        assert_eq!((&snapshot["workers"], &snapshot["pending"]), (&json!([]), &json!([])));
        assert_eq!(snapshot["uiConfig"]["features"]["remote"], json!(true), "the app's own ui configuration");
        let health = phone.get("/health").await.ok();
        assert_eq!(health["ok"], true);
        assert!(home.read("remote/remote-audit.log").contains(r#""action":"GET /health""#), "every request is logged");
        assert!(app.shutdown(Duration::from_secs(5)).await.clean());
        assert_eq!(awake.held(), 0, "released when the app goes");
        phone.closed().await;

        // A restart keeps the room and the bearer: a paired phone stays paired.
        let again = build();
        again.start().await.expect("starts");
        let (_, same) = dashboard(&again, Method::Post, "/api/remote/pair").await;
        assert_eq!((&same["room"], &same["bearer"]), (&code["room"], &code["bearer"]));
        assert!(again.shutdown(Duration::from_secs(5)).await.clean());
        relay.stop().await;
    }
}
