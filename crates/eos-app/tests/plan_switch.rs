//! A turn that runs into its plan's limit, through the real engine against
//! the engine's scripted model API, on sign-in stores made for the test (read
//! from their plaintext files; the keychain is never asked):
//!
//! - with a second sign-in ready, the session moves to it and the refused
//!   request goes out again on it;
//! - with none, the `accounts_exhausted` row stands in for the provider's
//!   notice, and "Use API key" or "Resume at" carry the turn on.

#[path = "support/rig.rs"]
mod rig;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use eos_app::{AgentOptions, App, Options};
use eos_core::{BoxFuture, Sleeper};
use eos_engine::mock_api::{MockApi, Recorded, Reply};
use eos_runtime::http::Method;
use eos_testkit::{NoKeychain, TempHome};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(30);

/// Real timers, none longer than a few seconds: "Resume at" waits for the
/// limit's reset plus half a minute of slack.
struct Brisk;

impl Sleeper for Brisk {
    fn sleep(&self, ms: i64) -> BoxFuture<'static, ()> {
        let ms = u64::try_from(ms.clamp(0, 4_000)).unwrap_or(0);
        Box::pin(tokio::time::sleep(Duration::from_millis(ms)))
    }
}

/// A Claude sign-in's store folder, holding a login that does not need renewing.
fn store(home: &Path, name: &str, token: &str) -> String {
    let dir = home.join("accounts").join(format!("claude-{name}"));
    std::fs::create_dir_all(&dir).expect("a store");
    let login = json!({"claudeAiOauth": {"accessToken": token, "refreshToken": format!("refresh-{name}"),
        "expiresAt": 4_102_444_800_000_u64, "scopes": ["user:inference", "user:profile"], "subscriptionType": "max"}});
    std::fs::write(dir.join(".credentials.json"), login.to_string()).expect("a login");
    dir.to_string_lossy().into_owned()
}

/// Makes `name`'s login one whose access token lapsed and that holds no way
/// to renew it.
fn unrenewable(home: &Path, name: &str) {
    let dir = home.join("accounts").join(format!("claude-{name}"));
    let login = json!({"claudeAiOauth": {"accessToken": format!("tok-{name}"), "expiresAt": 1_000_u64,
        "scopes": ["user:inference", "user:profile"], "subscriptionType": "team"}});
    std::fs::write(dir.join(".credentials.json"), login.to_string()).expect("a login");
}

/// Signs `names` in (the first is the default), with an API key beside them.
fn sign_in(home: &Path, names: &[&str]) {
    let logins: Vec<Value> = names
        .iter()
        .map(|name| {
            json!({"id": format!("login-{name}"), "provider": "anthropic", "label": format!("{name}@example.com"),
                "email": format!("{name}@example.com"), "storeDir": store(home, name, &format!("tok-{name}")),
                "createdAt": "2026-01-01T00:00:00.000Z"})
        })
        .collect();
    let registry = json!({"v": 1, "logins": logins, "defaults": {"anthropic": format!("login-{}", names[0])}});
    std::fs::write(home.join("accounts/logins.json"), registry.to_string()).expect("the registry");
    std::fs::write(home.join("config.json"), json!({"anthropic": {"apiKey": "k-paid"}}).to_string()).expect("config");
}

/// The plan's limit, reached: it resets `in_secs` from now.
fn limit_reached(in_secs: u64) -> Reply {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("a clock").as_secs();
    let headers = [
        ("anthropic-ratelimit-unified-status", "rejected".to_owned()),
        ("anthropic-ratelimit-unified-reset", (now + in_secs).to_string()),
        ("anthropic-ratelimit-unified-representative-claim", "five_hour".to_owned()),
        ("x-should-retry", "true".to_owned()),
    ];
    Reply::Status {
        status: 429,
        headers: headers.into_iter().map(|(name, value)| (name.to_owned(), value)).collect(),
        body: json!({"type": "error", "error": {"type": "rate_limit_error", "message": "limit reached"}}).to_string(),
    }
}

struct Bench {
    _home: TempHome,
    _folder: tempfile::TempDir,
    _claude: tempfile::TempDir,
    mock: MockApi,
    app: App,
    frames: rig::Frames,
}

impl Bench {
    async fn new(names: &[&str], replies: Vec<Reply>) -> Self {
        Self::with(names, replies, |_| {}).await
    }

    /// As [`Bench::new`], with the data folder changed by `prepare` first.
    async fn with(names: &[&str], replies: Vec<Reply>, prepare: impl FnOnce(&Path)) -> Self {
        let home = TempHome::new();
        sign_in(home.path(), names);
        prepare(home.path());
        let mock = MockApi::start(replies).await.expect("the scripted model API");
        let claude = tempfile::tempdir().expect("a folder");
        let options = Options {
            sleeper: Arc::new(Brisk),
            secrets: Arc::new(NoKeychain),
            env: Default::default(),
            launchd: None,
            agents: AgentOptions {
                base_url: Some(mock.base_url()),
                claude_home: Some(claude.path().to_owned()),
                no_mcp: true,
                default_model: Some("mock-model".into()),
                one_shot: Some(Arc::new(rig::Summarizer)),
                ..AgentOptions::default()
            },
            ..Options::new(home.path())
        };
        let app = App::build(options).expect("builds");
        app.start().await.expect("starts");
        let frames = rig::Frames::new(rig::open_stream(&app, "").await.expect("a stream"));
        let folder = tempfile::tempdir().expect("a folder");
        Self { _home: home, _folder: folder, _claude: claude, mock, app, frames }
    }

    async fn chat(&mut self, prompt: &str) -> String {
        let cwd = self._folder.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
        let body = json!({"mode": "focused", "cwd": cwd, "prompt": prompt});
        let (status, created) = rig::call(&self.app, Method::Post, "/orchestrators", Some(body)).await;
        assert_eq!(status, 201, "{created}");
        created["id"].as_str().expect("an id").to_owned()
    }

    async fn idle(&mut self, id: &str) {
        let went = self.frames.until(WAIT, |f| rig::went(f, id, "IDLE")).await;
        assert!(went.is_some(), "the turn ends");
    }

    async fn requests(&self, count: usize) -> Vec<Recorded> {
        let deadline = tokio::time::Instant::now() + WAIT;
        while self.mock.requests().len() < count && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.mock.requests()
    }

    /// The chat's rows of `kind`, with their payloads read.
    async fn rows(&self, id: &str, kind: &str) -> Vec<(i64, Value)> {
        let (_, rows) =
            rig::call(&self.app, Method::Get, &format!("/workers/{id}/events?order=asc&limit=500"), None).await;
        rows.as_array()
            .into_iter()
            .flatten()
            .filter(|row| row["type"] == kind)
            .map(|row| {
                let payload = row["payload"].as_str().and_then(|p| serde_json::from_str(p).ok()).unwrap_or(Value::Null);
                (row["id"].as_i64().unwrap_or_default(), payload)
            })
            .collect()
    }

    /// Claude's account as Settings › Accounts reads it.
    async fn claude(&self) -> Value {
        let (status, answer) = rig::call(&self.app, Method::Get, "/api/accounts", None).await;
        assert_eq!(status, 200, "{answer}");
        let all = answer.get("accounts").unwrap_or(&answer).as_array().cloned().unwrap_or_default();
        all.into_iter().find(|a| a["id"] == "anthropic").unwrap_or_else(|| panic!("no Claude account: {answer}"))
    }

    async fn transcript(&self, id: &str) -> String {
        let (_, rows) =
            rig::call(&self.app, Method::Get, &format!("/workers/{id}/events?order=asc&limit=500"), None).await;
        rows.to_string()
    }
}

fn bearer(request: &Recorded) -> Option<&str> {
    request.headers.get("authorization").and_then(|v| v.to_str().ok())
}

fn api_key(request: &Recorded) -> Option<&str> {
    request.headers.get("x-api-key").and_then(|v| v.to_str().ok())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_limit_with_another_sign_in_ready_moves_the_session_and_sends_the_request_again() {
    let mut b = Bench::new(&["a", "b"], vec![limit_reached(3600), Reply::text("answered on b")]).await;
    let id = b.chat("say hello").await;
    b.idle(&id).await;

    let requests = b.requests(2).await;
    assert_eq!(requests.len(), 2, "the refused request, then the same one again");
    assert_eq!((bearer(&requests[0]), bearer(&requests[1])), (Some("Bearer tok-a"), Some("Bearer tok-b")));
    assert_eq!(requests[0].json()["messages"], requests[1].json()["messages"], "the same request");

    let switched = b.rows(&id, "account_switched").await;
    assert_eq!(switched.len(), 1, "{}", b.transcript(&id).await);
    let row = &switched[0].1;
    assert_eq!(
        (&row["from"], &row["to"], &row["reason"]),
        (&json!("a@example.com"), &json!("b@example.com"), &json!("limit"))
    );
    assert!(row["resetsAt"].is_string(), "{row}");
    let transcript = b.transcript(&id).await;
    assert!(transcript.contains("answered on b"), "the turn carried on: {transcript}");
    assert!(!transcript.contains("limit reached"), "the refusal never shows: {transcript}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_every_sign_in_out_the_turn_goes_on_with_the_api_key_when_the_user_says_so() {
    let mut b = Bench::new(&["a"], vec![limit_reached(3600), Reply::text("answered on the key")]).await;
    let id = b.chat("say hello").await;
    let told = b.frames.until(WAIT, |f| f["reason"] == "notification:fire").await.expect("the user is told");
    assert_eq!(told["payload"]["title"], "Claude accounts are out", "{told}");
    b.idle(&id).await;

    let exhausted = b.rows(&id, "accounts_exhausted").await;
    assert_eq!(exhausted.len(), 1, "{}", b.transcript(&id).await);
    let row = &exhausted[0].1;
    assert_eq!((&row["provider"], &row["apiKey"]), (&json!("anthropic"), &json!(true)), "{row}");
    assert!(row["nextResetAt"].is_string(), "{row}");
    assert!(!b.transcript(&id).await.contains("limit reached"), "the row stands in for the provider's notice");

    let (status, answer) = rig::call(&b.app, Method::Post, &format!("/workers/{id}/api-key-continue"), None).await;
    assert_eq!(status, 200, "{answer}");
    b.idle(&id).await;
    let requests = b.requests(2).await;
    assert_eq!(requests.len(), 2);
    assert_eq!((bearer(&requests[0]), api_key(&requests[1])), (Some("Bearer tok-a"), Some("k-paid")));
    assert_eq!(requests[0].json()["messages"], requests[1].json()["messages"], "the cut-off turn, again");
    let switched = b.rows(&id, "account_switched").await;
    assert_eq!(switched.len(), 1, "{}", b.transcript(&id).await);
    assert_eq!((&switched[0].1["to"], &switched[0].1["reason"]), (&json!("API key"), &json!("api_key")));
    assert!(b.transcript(&id).await.contains("answered on the key"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_every_sign_in_out_resume_at_carries_the_turn_on_once_the_limit_resets() {
    let mut b = Bench::new(&["a"], vec![limit_reached(2), Reply::text("answered after the reset")]).await;
    let id = b.chat("say hello").await;
    b.idle(&id).await;
    let exhausted = b.rows(&id, "accounts_exhausted").await;
    assert_eq!(exhausted.len(), 1, "{}", b.transcript(&id).await);
    let (row_id, _) = exhausted[0];

    let resume = json!({"rowId": row_id, "on": true});
    let (status, answer) = rig::call(&b.app, Method::Put, &format!("/workers/{id}/plan-resume"), Some(resume)).await;
    assert_eq!(status, 200, "{answer}");
    let scheduled = b.rows(&id, "accounts_exhausted").await;
    assert!(scheduled[0].1["resumeAt"].is_string(), "every window shows the schedule: {}", scheduled[0].1);

    let requests = b.requests(2).await;
    assert_eq!(requests.len(), 2, "the turn ran again once the limit reset");
    assert_eq!((bearer(&requests[0]), bearer(&requests[1])), (Some("Bearer tok-a"), Some("Bearer tok-a")));
    assert_eq!(requests[0].json()["messages"], requests[1].json()["messages"]);
    b.idle(&id).await;
    let switched = b.rows(&id, "account_switched").await;
    assert_eq!(switched.len(), 1, "{}", b.transcript(&id).await);
    assert_eq!((&switched[0].1["to"], &switched[0].1["reason"]), (&json!("a@example.com"), &json!("reset")));
    let resumed = b.rows(&id, "accounts_exhausted").await;
    assert_eq!(resumed[0].1["resumed"], json!(true), "{}", resumed[0].1);
    assert!(resumed[0].1.get("resumeAt").is_none(), "{}", resumed[0].1);
    assert!(b.transcript(&id).await.contains("answered after the reset"));
}

fn login_states(claude: &Value) -> Vec<(String, String)> {
    let logins = claude["logins"].as_array().cloned().unwrap_or_default();
    logins
        .iter()
        .map(|l| (l["id"].as_str().unwrap_or("").to_owned(), l["state"].as_str().unwrap_or("").to_owned()))
        .collect()
}

// The TypeScript app counts a store holding either token as signed in
// (`readClaudeCodeLogin`), so a sign-in whose access token lapsed with no way
// to renew it shows as signed in until a turn finds out. That turn ends on
// `authentication_failed`, `SwitchSessionAccount` marks the sign-in expired,
// and the session moves to a ready one; with none, the provider's state is
// `expired` and its route `blocked`, the key unused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sign_in_that_cannot_be_renewed_is_found_out_by_its_first_turn() {
    let mut b = Bench::with(&["a", "b"], vec![Reply::text("answered on b")], |home| unrenewable(home, "a")).await;
    let before = b.claude().await;
    assert_eq!(login_states(&before), [("login-a".into(), "signed_in".into()), ("login-b".into(), "signed_in".into())]);
    assert_eq!((&before["route"], &before["subscription"]["state"]), (&json!("subscription"), &json!("signed_in")));

    let id = b.chat("say hello").await;
    b.idle(&id).await;
    let requests = b.requests(1).await;
    assert_eq!(requests.iter().map(bearer).collect::<Vec<_>>(), [Some("Bearer tok-b")], "nothing went out on a");
    let switched = b.rows(&id, "account_switched").await;
    assert_eq!(switched.len(), 1, "{}", b.transcript(&id).await);
    assert_eq!((&switched[0].1["from"], &switched[0].1["reason"]), (&json!("a@example.com"), &json!("expired")));
    let after = b.claude().await;
    assert_eq!(login_states(&after), [("login-a".into(), "expired".into()), ("login-b".into(), "signed_in".into())]);
    assert_eq!(after["route"], json!("subscription"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_no_other_sign_in_one_that_cannot_be_renewed_blocks_its_provider() {
    let mut b = Bench::with(&["a"], vec![Reply::text("never sent")], |home| unrenewable(home, "a")).await;
    let id = b.chat("say hello").await;
    b.idle(&id).await;
    assert_eq!(b.rows(&id, "accounts_exhausted").await.len(), 1, "{}", b.transcript(&id).await);
    assert!(b.mock.requests().is_empty(), "the API key is not used without the user's say");
    let after = b.claude().await;
    assert_eq!(login_states(&after), [("login-a".into(), "expired".into())]);
    assert_eq!((&after["route"], &after["subscription"]["state"]), (&json!("blocked"), &json!("expired")));
}

// The registry records each store's absolute path (as the TypeScript app
// writes it). A copy of a data folder still names the original's stores, and
// with them the original's sign-ins and keychain items: it reads its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_copy_of_a_data_folder_reads_its_own_sign_ins() {
    let original = TempHome::new();
    sign_in(original.path(), &["a"]);
    let before = std::fs::read(original.join("accounts/claude-a/.credentials.json")).expect("the original's login");
    let copy = TempHome::new();
    copy.write("accounts/logins.json", original.read("accounts/logins.json"));
    let options =
        Options { secrets: Arc::new(NoKeychain), env: Default::default(), launchd: None, ..Options::new(copy.path()) };
    let app = App::build(options).expect("builds");
    app.start().await.expect("starts");

    let (_, answer) = rig::call(&app, Method::Get, "/api/accounts", None).await;
    let all = answer.get("accounts").unwrap_or(&answer).as_array().cloned().unwrap_or_default();
    let claude = all.into_iter().find(|a| a["id"] == "anthropic").expect("Claude");
    assert_eq!(login_states(&claude), [("login-a".into(), "signed_out".into())], "not the original's sign-in");
    let (status, _) = rig::call(&app, Method::Delete, "/api/accounts/anthropic/logins/login-a", None).await;
    assert_eq!(status, 200);
    app.shutdown(Duration::from_secs(5)).await;
    let after = std::fs::read(original.join("accounts/claude-a/.credentials.json")).expect("still there");
    assert_eq!(before, after, "a sign-out in the copy leaves the original's store alone");
}
