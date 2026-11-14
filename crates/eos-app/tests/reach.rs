//! Only the installed app on the user's own data folder acts as the user
//! beyond this computer (`Options::reaches_network`). A run on any other data
//! folder, here one holding a switched-on phone link, a sync key and a
//! release install, opens no connection: each service is pointed at a local
//! listener that counts what reaches it, and the same app on the network is
//! the proof that it would have. Every screen says why it does nothing,
//! never "not signed in" or "not set". Paired computers: `tests/peer.rs`;
//! Eos's own reads of the user's accounts: `src/reach.rs`. Sign-in stores are
//! plaintext files made for the test; the keychain is never asked.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use eos_app::{App, Options};
use eos_core::net::relay::Relay;
use eos_domain::sync::{SyncIdentity, format_sync_key};
use eos_relay::{RelayClient, RelayOptions};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_testkit::relay::FakeRelay;
use eos_testkit::{FakeClock, NoKeychain, SeqIds, TempHome};
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// A loopback port that counts the connections made to it and closes them.
struct Counting {
    port: u16,
    accepted: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Counting {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
        let port = listener.local_addr().expect("its address").port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = accepted.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        Self { port, accepted, task }
    }

    fn accepted(&self) -> usize {
        self.accepted.load(Ordering::SeqCst)
    }
}

impl Drop for Counting {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn options(home: &TempHome, network: bool) -> Options {
    Options {
        clock: Arc::new(FakeClock::new()),
        ids: Arc::new(SeqIds::new()),
        env: Default::default(),
        secrets: Arc::new(NoKeychain),
        launchd: None,
        reaches_network: network,
        ..Options::new(home.path())
    }
}

/// A Claude sign-in (`login-a`, the default) whose token needs no renewing,
/// and the usage the last run saved: its, and ChatGPT's from before that
/// sign-in went away. Answers the saved file.
fn signed_in_with_saved_usage(home: &TempHome) -> String {
    let login = json!({"claudeAiOauth": {"accessToken": "tok-a", "refreshToken": "refresh-a",
        "expiresAt": 4_102_444_800_000_u64, "scopes": ["user:inference", "user:profile"], "subscriptionType": "max"}});
    home.write("accounts/claude-a/.credentials.json", login.to_string());
    let store = home.join("accounts/claude-a").to_string_lossy().into_owned();
    let entry = json!({"id": "login-a", "provider": "anthropic", "label": "a@example.com", "email": "a@example.com",
        "storeDir": store, "createdAt": "2026-01-01T00:00:00.000Z"});
    home.write(
        "accounts/logins.json",
        json!({"v": 1, "logins": [entry], "defaults": {"anthropic": "login-a"}}).to_string(),
    );
    let saved = json!([
        {"provider": "claude", "loginId": "login-a", "label": "a@example.com", "plan": "Max",
         "windows": {"fiveHour": {"utilization": 42, "resetsAt": null}}, "fetchedAt": "2026-11-13T00:00:00.000Z"},
        {"provider": "codex", "plan": "Plus", "windows": {}, "fetchedAt": "2026-11-13T00:00:00.000Z"}
    ]);
    home.write("usage-cache.json", saved.to_string());
    saved.to_string()
}

async fn call(app: &App, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = Request::new(method, target, Caller::DASHBOARD);
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body.to_string());
    }
    let response = app.router().handle(request).await;
    let status = response.status;
    let bytes = response.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(tokio::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_switched_on_phone_link_never_dials_its_relay() {
    let relay = FakeRelay::start().await;
    let home = TempHome::new();
    let build = |network| {
        let dialler = RelayClient::with_options(
            Arc::new(FakeClock::new()),
            RelayOptions { backoff_min: Duration::from_millis(40), ..RelayOptions::default() },
        );
        let env = eos_domain::config::Env::new([
            ("EOS_REMOTE_ENABLED".to_owned(), "1".to_owned()),
            ("EOS_REMOTE_RELAY_URL".to_owned(), relay.url()),
        ]);
        App::build(Options { env, relay: Some(Arc::new(dialler) as Arc<dyn Relay>), ..options(&home, network) })
            .expect("builds")
    };

    let away = build(false);
    away.start().await.expect("starts");
    let _ = call(&away, Method::Post, "/api/remote/arm", None).await;
    let (_, status) = call(&away, Method::Get, "/api/remote/status", None).await;
    assert_eq!((&status["armed"], &status["off"]), (&json!(false), &json!("off-network")), "{status}");
    let (code, refused) = call(&away, Method::Post, "/api/remote/pair", None).await;
    let why = json!("The phone link runs only in the installed Eos on your own data folder");
    assert_eq!((code, &refused["error"]), (409, &why), "not a missing relay URL: {refused}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!away.remote().is_armed());
    assert_eq!(relay.accepted(), 0, "nothing reached the relay");
    away.shutdown(Duration::from_secs(5)).await;

    let installed = build(true);
    installed.start().await.expect("starts");
    until("the installed app dials its relay", || relay.accepted() > 0).await;
    let (_, status) = call(&installed, Method::Get, "/api/remote/status", None).await;
    assert_eq!(status.get("off"), None, "{status}");
    installed.shutdown(Duration::from_secs(5)).await;
    relay.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sync_key_in_the_data_folder_never_reaches_its_vault() {
    let vault = Counting::start().await;
    let relay_url = format!("ws://127.0.0.1:{}/", vault.port);
    let identity = SyncIdentity { relay_url: relay_url.clone(), secret: [7; 32] };
    let home = TempHome::new();
    let secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
    home.write("sync/identity.json", json!({ "relayUrl": relay_url, "secret": secret }).to_string());

    let away = App::build(options(&home, false)).expect("builds");
    away.start().await.expect("starts");
    let (_, status) = call(&away, Method::Get, "/api/sync", None).await;
    assert_eq!(status["relay"], json!(format!("127.0.0.1:{}", vault.port)), "the key is there: {status}");
    let _ = call(&away, Method::Post, "/api/sync/now", None).await;
    let key = json!({ "key": format_sync_key(&identity) });
    let (joined, _) = call(&away, Method::Post, "/api/sync/join", Some(key)).await;
    assert_eq!(joined, 200, "joining is only recorded");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (_, status) = call(&away, Method::Get, "/api/sync", None).await;
    assert_eq!(status["error"], json!("Sync runs only in the installed Eos on your own data folder"), "{status}");
    assert_eq!(vault.accepted(), 0, "nothing reached the vault");
    away.shutdown(Duration::from_secs(5)).await;

    let installed = App::build(options(&home, true)).expect("builds");
    installed.start().await.expect("starts");
    until("the installed app reaches its vault", || vault.accepted() > 0).await;
    installed.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_access_says_that_this_run_lets_no_other_computer_in() {
    let home = TempHome::new();
    let relay = "wss://relay.example.com/";
    home.write("config.json", json!({ "peer": { "enabled": true, "direct": true, "relayUrl": relay } }).to_string());

    let away = App::build(options(&home, false)).expect("builds");
    away.start().await.expect("starts");
    let (_, status) = call(&away, Method::Get, "/api/peer", None).await;
    assert_eq!((status["enabled"].as_bool(), status["listening"].as_bool()), (Some(true), Some(false)));
    assert_eq!(status["off"], json!("off-network"), "not a port another app holds: {status}");
    assert_eq!(status["relay"], json!({ "url": relay, "online": false }), "the relay is set, not dialled");
    let (code, refused) = call(&away, Method::Post, "/api/peer/invite", None).await;
    assert_eq!(code, 409, "an invite would name no way in: {refused}");
    assert_eq!(refused["error"], json!("Only the installed Eos on your own data folder lets other computers in"));
    // With hosting off that is the reason, as today.
    let (_, saved) = call(&away, Method::Put, "/api/peer", Some(json!({ "enabled": false }))).await;
    assert_eq!((saved.get("off"), &saved["relay"]), (None, &Value::Null), "{saved}");
    away.shutdown(Duration::from_secs(5)).await;

    // On the network the answer is today's: no such field.
    home.write("config.json", json!({ "peer": { "enabled": false } }).to_string());
    let installed = App::build(options(&home, true)).expect("builds");
    installed.start().await.expect("starts");
    let (_, status) = call(&installed, Method::Get, "/api/peer", None).await;
    assert_eq!((status.get("off"), &status["relay"]), (None, &Value::Null), "{status}");
    installed.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn machines_say_that_this_run_dials_no_host() {
    let paired = Counting::start().await;
    let home = TempHome::new();
    let id = "b".repeat(64);
    let host = json!({ "id": id, "name": "Studio", "alias": null, "platform": "darwin",
        "addrs": [format!("127.0.0.1:{}", paired.port)], "pairedAt": 1, "lastConnectedAt": null });
    home.write("peer/hosts.json", json!([host]).to_string());

    let away = App::build(options(&home, false)).expect("builds");
    away.start().await.expect("starts");
    let (_, hosts) = call(&away, Method::Get, "/api/hosts", None).await;
    let link = &hosts["hosts"][0]["link"];
    assert_eq!((&link["state"], &link["error"]), (&json!("offline"), &json!("off-network")), "{hosts}");
    let (reconnected, _) = call(&away, Method::Post, &format!("/api/hosts/{id}/reconnect"), None).await;
    assert_eq!(reconnected, 200);
    let (_, hosts) = call(&away, Method::Get, "/api/hosts", None).await;
    assert_eq!(hosts["hosts"][0]["link"]["error"], json!("off-network"), "still: {hosts}");
    let token = away.callers().view_tokens().mint(&id);
    let target = format!("/h/{id}/workers");
    let view = away.callers().classify_for(Some(&token), &target);
    let forwarded = away.router().handle(Request::new(Method::Get, &target, view)).await;
    let body: Value = serde_json::from_slice(&forwarded.body.collect().await.expect("a body")).expect("json");
    assert_eq!((forwarded.status, &body["code"]), (503, &json!("off-network")), "{body}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(paired.accepted(), 0, "nothing reached the paired computer");
    away.shutdown(Duration::from_secs(5)).await;

    let installed = App::build(options(&home, true)).expect("builds");
    installed.start().await.expect("starts");
    until("the installed app dials its paired computer", || paired.accepted() > 0).await;
    let (_, hosts) = call(&installed, Method::Get, "/api/hosts", None).await;
    assert_ne!(hosts["hosts"][0]["link"]["error"], json!("off-network"), "{hosts}");
    installed.shutdown(Duration::from_secs(5)).await;
}

/// Not "not signed in": the sign-in is there, this run only does not read it.
#[tokio::test(flavor = "multi_thread")]
async fn usage_and_artifacts_say_that_this_run_reads_no_account() {
    let home = TempHome::new();
    signed_in_with_saved_usage(&home);
    let why = json!("Only the installed Eos on your own data folder reads your accounts");

    let away = App::build(options(&home, false)).expect("builds");
    away.start().await.expect("starts");
    let (_, accounts) = call(&away, Method::Get, "/api/accounts", None).await;
    assert_eq!(accounts["accounts"][0]["logins"][0]["state"], json!("signed_in"), "{accounts}");

    let (_, usage) = call(&away, Method::Get, "/api/usage?wait=1", None).await;
    let errors = usage["errors"].as_array().cloned().unwrap_or_default();
    let claude = errors.iter().find(|e| e["provider"] == json!("claude:login-a"));
    assert_eq!(claude.map(|e| &e["reason"]), Some(&why), "{usage}");
    let held = &usage["providers"][0];
    assert_eq!((&held["loginId"], &held["stale"]), (&json!("login-a"), &json!(true)), "the last usage, not refreshed");
    assert_eq!(held["windows"]["fiveHour"]["utilization"], json!(42));

    let (_, catalog) = call(&away, Method::Post, "/api/artifacts/refresh", None).await;
    assert_eq!(catalog["accounts"][0]["error"], why, "{catalog}");
    away.shutdown(Duration::from_secs(5)).await;
}

/// The TypeScript app reads the same file: going back to it, the usage it
/// saved is still there.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_reads_no_usage_leaves_the_saved_usage_as_it_was() {
    let home = TempHome::new();
    let saved = signed_in_with_saved_usage(&home);

    let away = App::build(options(&home, false)).expect("builds");
    away.start().await.expect("starts");
    let (_, usage) = call(&away, Method::Get, "/api/usage?wait=1", None).await;
    assert_eq!(usage["providers"][0]["loginId"], json!("login-a"), "{usage}");
    away.shutdown(Duration::from_secs(5)).await;
    assert_eq!(home.read("usage-cache.json"), saved, "never written");
}

/// A release bundle as macOS lays it out: `Eos.app/Contents/MacOS/Eos`, its
/// `update.json` among the resources.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn release_bundle(dir: &std::path::Path) -> std::path::PathBuf {
    let contents = dir.join("Eos.app/Contents");
    std::fs::create_dir_all(contents.join("MacOS")).expect("a bundle");
    std::fs::create_dir_all(contents.join("Resources")).expect("a bundle");
    let info = json!({ "version": "0.2.0", "channel": "stable", "platform": "darwin-arm64" });
    std::fs::write(contents.join("Resources/update.json"), info.to_string()).expect("update.json");
    let exe = contents.join("MacOS/Eos");
    std::fs::write(&exe, b"").expect("the executable");
    exe
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test(flavor = "multi_thread")]
async fn a_release_install_never_asks_its_update_feed() {
    let feed = Counting::start().await;
    let apps = tempfile::tempdir().expect("a folder");
    let exe = release_bundle(apps.path());
    let home = TempHome::new();
    // A feed must be https: the connection is counted before its handshake fails.
    let url = format!("https://127.0.0.1:{}", feed.port);
    home.write("config.json", json!({ "updates": { "feedUrl": url } }).to_string());
    let build =
        |network| App::build(Options { exec_path: Some(exe.clone()), ..options(&home, network) }).expect("builds");

    let away = build(false);
    let feed_url = away.config().current().updates.feed_url.clone();
    assert_eq!(feed_url.as_deref(), Some(url.as_str()), "never the real feed");
    away.start().await.expect("starts");
    let (_, status) = call(&away, Method::Get, "/api/update", None).await;
    assert_eq!(status["status"]["off"], json!("dev-build"), "{status}");
    let _ = call(&away, Method::Post, "/api/update/check", Some(json!({ "trigger": "manual" }))).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(feed.accepted(), 0, "nothing reached the feed");
    away.shutdown(Duration::from_secs(5)).await;

    let installed = build(true);
    installed.start().await.expect("starts");
    let (_, status) = call(&installed, Method::Get, "/api/update", None).await;
    assert_eq!(status["status"]["off"], Value::Null, "{status}");
    let _ = call(&installed, Method::Post, "/api/update/check", Some(json!({ "trigger": "manual" }))).await;
    until("the installed app asks its feed", || feed.accepted() > 0).await;
    installed.shutdown(Duration::from_secs(5)).await;
}
