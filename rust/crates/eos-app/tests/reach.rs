//! Only the installed app on the user's own data folder acts as the user
//! beyond this computer (`Options::reaches_network`). A run on any other data
//! folder, here one holding a switched-on phone link, a sync key and a
//! release install, opens no connection: each service is pointed at a local
//! listener that counts what reaches it, and the same app on the network is
//! the proof that it would have. Paired computers: `tests/peer.rs`; Eos's own
//! reads of the user's accounts: `src/reach.rs`.

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
use eos_testkit::{FakeClock, SeqIds, TempHome};
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
        launchd: None,
        reaches_network: network,
        ..Options::new(home.path())
    }
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
    let _ = call(&away, Method::Post, "/api/remote/pair", None).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!away.remote().is_armed());
    assert_eq!(relay.accepted(), 0, "nothing reached the relay");
    away.shutdown(Duration::from_secs(5)).await;

    let installed = build(true);
    installed.start().await.expect("starts");
    until("the installed app dials its relay", || relay.accepted() > 0).await;
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
