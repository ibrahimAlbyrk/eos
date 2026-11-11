//! The credential stores, the sign-in flows and the usage endpoint against
//! local stand-ins: a throwaway keychain file, a temporary folder, a fake
//! server on a loopback port. No real account, store or provider is touched.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use eos_auth::{ChatGptSignIn, ClaudeTokenProbe, ClaudeUsageApi, Endpoints, Stores};
use eos_core::accounts::{PlanStores, PlanUsageApi, StoreLogin, SubscriptionProvider, TokenProbe, TokenProbeResult};
use eos_platform::CredentialStore;
use eos_testkit::{FakeClock, TempHome};
use serde_json::{Value, json};
use support::FakeServer;

/// A system with no secret store: the claude binary's file store is all there is.
#[derive(Debug)]
struct NoKeychain;

impl CredentialStore for NoKeychain {
    fn read_claude_store(&self, _store_dir: Option<&Path>) -> Option<String> {
        None
    }

    fn write_claude_store(&self, _store_dir: &Path, _json: &str) -> Result<(), eos_platform::Error> {
        Err(eos_platform::Error::Unsupported("secret storage"))
    }

    fn clear_claude_store(&self, _store_dir: &Path) {}

    fn read_secret(&self, _service: &str) -> Option<String> {
        None
    }

    fn write_secret(&self, _service: &str, _secret: &str) -> Result<(), eos_platform::Error> {
        Err(eos_platform::Error::Unsupported("secret storage"))
    }

    fn delete_secret(&self, _service: &str) {}
}

fn far_future() -> u64 {
    4_102_444_800_000
}

/// A token endpoint whose refresh tokens work once, as Claude's do.
async fn token_server() -> (FakeServer, Arc<AtomicUsize>) {
    let renewals = Arc::new(AtomicUsize::new(0));
    let count = renewals.clone();
    let server = FakeServer::start(move |hit| {
        if support::query_value(&hit.body, "refresh_token").as_deref() != Some("rt-1") {
            return (400, json!({ "error": "invalid_grant" }).to_string());
        }
        if count.fetch_add(1, Ordering::SeqCst) > 0 {
            return (400, json!({ "error": "invalid_grant", "error_description": "refresh token reused" }).to_string());
        }
        (200, json!({ "access_token": "at-new", "refresh_token": "rt-2", "expires_in": 3600 }).to_string())
    })
    .await;
    (server, renewals)
}

fn lapsed_login() -> String {
    json!({
        "claudeAiOauth": {
            "accessToken": "at-old", "refreshToken": "rt-1", "expiresAt": 1000,
            "scopes": ["user:inference", "user:profile"], "subscriptionType": "max",
        },
        "mcpOAuth": { "linear": { "token": "kept" } },
    })
    .to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_store_is_read_renewed_once_by_everyone_who_shares_it_and_signed_out() {
    let home = TempHome::new();
    let dir = home.join("accounts/claude");
    home.write("accounts/claude/.credentials.json", lapsed_login());
    home.write("accounts/claude/.claude.json", r#"{"oauthAccount":{"emailAddress":" me@example.com "}}"#);
    let store = dir.to_string_lossy().into_owned();
    let (server, renewals) = token_server().await;
    let endpoints = Endpoints { claude_token_url: Some(format!("{}/token", server.url)), ..Endpoints::default() };
    // Two holders of one store, as the app's own reads and an agent are.
    let (ours, theirs) =
        (Stores::new(Arc::new(NoKeychain), endpoints.clone()), Stores::new(Arc::new(NoKeychain), endpoints));

    let read = ours.read("anthropic", &store).await;
    assert_eq!(read, StoreLogin { present: true, plan: Some("max".into()), email: Some("me@example.com".into()) });
    assert_eq!(
        ours.read("anthropic", &home.join("accounts/claude-none").to_string_lossy()).await,
        StoreLogin::default()
    );

    let tokens = tokio::join!(
        ours.access_token("anthropic", &store),
        theirs.access_token("anthropic", &store),
        ours.access_token("anthropic", &store),
        theirs.access_token("anthropic", &store),
    );
    assert_eq!(tokens, (Some("at-new".into()), Some("at-new".into()), Some("at-new".into()), Some("at-new".into())));
    assert_eq!(renewals.load(Ordering::SeqCst), 1, "a single-use refresh token is spent once");
    let renewal = &server.hits()[0];
    assert_eq!(renewal.headers.get("content-type").map(String::as_str), Some("application/x-www-form-urlencoded"));
    assert_eq!(support::query_value(&renewal.body, "grant_type").as_deref(), Some("refresh_token"));

    let saved: Value = serde_json::from_str(&home.read("accounts/claude/.credentials.json")).expect("JSON");
    assert_eq!(saved["claudeAiOauth"]["refreshToken"], "rt-2");
    assert_eq!(saved["claudeAiOauth"]["subscriptionType"], "max", "what the renewal does not touch stays");
    assert_eq!(saved["mcpOAuth"]["linear"]["token"], "kept");
    assert!(!dir.join(".oauth_refresh.lock").exists(), "the refresh lock is released");

    ours.sign_out("anthropic", &store).await.expect("signs out");
    assert!(!ours.read("anthropic", &store).await.present);
    assert_eq!(ours.access_token("anthropic", &store).await, None);
    let rest: Value = serde_json::from_str(&home.read("accounts/claude/.credentials.json")).expect("JSON");
    assert_eq!(rest, json!({ "mcpOAuth": { "linear": { "token": "kept" } } }), "only the Claude sign-in goes");
    ours.sign_out("anthropic", &store).await.expect("signing out twice is not an error");

    // A store that held nothing else leaves no file behind.
    home.write("accounts/claude-lg-2/.credentials.json", r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r"}}"#);
    let second = home.join("accounts/claude-lg-2").to_string_lossy().into_owned();
    assert!(ours.read("anthropic", &second).await.present);
    ours.sign_out("anthropic", &second).await.expect("signs out");
    assert!(!home.join("accounts/claude-lg-2/.credentials.json").exists());
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn a_store_the_typescript_app_signed_in_keeps_working_from_its_keychain_item() {
    use eos_platform::SecurityKeychain;
    use support::keychain::Throwaway;

    let home = TempHome::new();
    let dir = home.join("accounts/claude");
    home.write("accounts/claude/.claude.json", r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#);
    let store = dir.to_string_lossy().into_owned();
    let throwaway = Throwaway::create();
    // The item `claude auth login` made with CLAUDE_SECURESTORAGE_CONFIG_DIR at this folder.
    throwaway.add_as_claude(&dir, &lapsed_login());
    let keychain = Arc::new(SecurityKeychain::file(&throwaway.path));
    let (server, renewals) = token_server().await;
    let endpoints = Endpoints { claude_token_url: Some(format!("{}/token", server.url)), ..Endpoints::default() };
    let (ours, theirs) = (Stores::new(keychain.clone(), endpoints.clone()), Stores::new(keychain.clone(), endpoints));

    let read = ours.read("anthropic", &store).await;
    assert_eq!(read, StoreLogin { present: true, plan: Some("max".into()), email: Some("me@example.com".into()) });
    let tokens = tokio::join!(ours.access_token("anthropic", &store), theirs.access_token("anthropic", &store));
    assert_eq!(tokens, (Some("at-new".into()), Some("at-new".into())));
    assert_eq!(renewals.load(Ordering::SeqCst), 1);

    // The renewal went back into the same item, under the account the claude binary gave it.
    assert_eq!(throwaway.items_of(&dir), (1, true));
    let saved: Value = serde_json::from_str(&keychain.read_claude_store(Some(&dir)).expect("the item")).expect("JSON");
    assert_eq!(
        (saved["claudeAiOauth"]["accessToken"].as_str(), saved["claudeAiOauth"]["refreshToken"].as_str()),
        (Some("at-new"), Some("rt-2"))
    );
    assert_eq!(saved["mcpOAuth"]["linear"]["token"], "kept");
    assert!(!dir.join(".credentials.json").exists(), "nothing is copied into a file");

    ours.sign_out("anthropic", &store).await.expect("signs out");
    assert!(!theirs.read("anthropic", &store).await.present);
    assert_eq!(throwaway.items_of(&dir).0, 1, "the item stays for what else it holds");
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn signing_in_to_claude_fills_the_store_from_the_browser_or_a_pasted_code() {
    use base64::Engine as _;
    use eos_agent_anthropic::auth::SignInConfig;
    use eos_auth::ClaudeSignIn;
    use eos_core::accounts::{SignInPages, SignInRequest};
    use eos_platform::SecurityKeychain;
    use sha2::{Digest, Sha256};
    use support::keychain::Throwaway;

    let home = TempHome::new();
    let throwaway = Throwaway::create();
    let keychain = Arc::new(SecurityKeychain::file(&throwaway.path));
    // The authorization server: a code is good once, with the verifier of its sign-in.
    let server = FakeServer::start(|hit| match hit.path() {
        "/token" => {
            let body: Value = serde_json::from_str(&hit.body).unwrap_or(Value::Null);
            let code = body["code"].as_str().unwrap_or_default();
            if body["grant_type"] != "authorization_code" || !code.starts_with("code-") {
                return (401, json!({ "error": "invalid_grant" }).to_string());
            }
            let answer = json!({
                "access_token": format!("at-{code}"), "refresh_token": format!("rt-{code}"), "expires_in": 3600,
                "scope": "user:inference user:profile", "verifier": body["code_verifier"],
            });
            (200, answer.to_string())
        }
        "/profile" => (
            200,
            json!({ "account": { "email": "me@example.com" }, "organization": { "organization_type": "claude_max" } })
                .to_string(),
        ),
        _ => (404, "{}".to_owned()),
    })
    .await;
    let config = SignInConfig {
        authorize_url: format!("{}/authorize", server.url),
        token_url: format!("{}/token", server.url),
        profile_url: format!("{}/profile", server.url),
        manual_redirect_url: format!("{}/code/callback", server.url),
        success_url: format!("{}/success", server.url),
        timeout: std::time::Duration::from_secs(30),
        ..SignInConfig::default()
    };
    let stores = Arc::new(Stores::new(keychain.clone(), Endpoints::default()));
    let provider = ClaudeSignIn::with_config(stores.clone(), config);
    assert!(provider.accepts_code() && provider.multi_login() && provider.id() == "anthropic");

    let start = |store: &str, hint: Option<&str>| {
        let (pages_tx, pages_rx) = tokio::sync::oneshot::channel::<SignInPages>();
        let (code_tx, code_rx) = tokio::sync::oneshot::channel::<String>();
        let flow = provider.sign_in(SignInRequest {
            store_dir: store.to_owned(),
            login_hint: hint.map(str::to_owned),
            on_pages: Box::new(move |pages| {
                let _ = pages_tx.send(pages);
            }),
            code: Box::pin(async move { code_rx.await.ok() }),
        });
        (tokio::spawn(flow), pages_rx, code_tx)
    };

    // The browser comes back to the loopback address by itself.
    let first = home.write("accounts/claude-lg-1/.keep", "").parent().expect("dir").to_string_lossy().into_owned();
    let (flow, pages, _code) = start(&first, Some("me@example.com"));
    let pages = pages.await.expect("the pages");
    let query = |url: &str, name: &str| support::query_value(url, name).expect(name);
    assert_eq!(query(&pages.open, "login_hint"), "me@example.com");
    assert_eq!(query(&pages.open, "code_challenge_method"), "S256");
    assert!(query(&pages.open, "redirect_uri").starts_with("http://localhost:"));
    assert_eq!(
        query(&pages.shown, "redirect_uri"),
        format!("{}/code/callback", server.url),
        "the page that shows a code"
    );
    let back = format!("{}?code=code-1&state={}", query(&pages.open, "redirect_uri"), query(&pages.open, "state"));
    let landed = reqwest::get(&back).await.expect("the callback answers");
    assert!(landed.status().is_success());
    let signed_in = flow.await.expect("the flow").expect("signs in");
    assert_eq!(signed_in.email.as_deref(), Some("me@example.com"));

    let exchange: Value = serde_json::from_str(&server.hits_to("/token")[0].body).expect("JSON");
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(exchange["code_verifier"].as_str().expect("a verifier").as_bytes()));
    assert_eq!(challenge, query(&pages.open, "code_challenge"), "the verifier answers the challenge");
    assert_eq!(
        server.hits_to("/profile")[0].headers.get("authorization").map(String::as_str),
        Some("Bearer at-code-1")
    );

    let read = stores.read("anthropic", &first).await;
    assert_eq!((read.present, read.plan.as_deref()), (true, Some("max")));
    assert_eq!(stores.access_token("anthropic", &first).await.as_deref(), Some("at-code-1"));
    // In the item the claude binary uses for that folder, in its format.
    let item: Value =
        serde_json::from_str(&keychain.read_claude_store(Some(Path::new(&first))).expect("the item")).expect("JSON");
    let saved = &item["claudeAiOauth"];
    assert_eq!((saved["refreshToken"].as_str(), saved["subscriptionType"].as_str()), (Some("rt-code-1"), Some("max")));
    assert!(saved["expiresAt"].as_u64().is_some_and(|at| at > 1_700_000_000_000) && saved["scopes"].is_array());

    // A browser elsewhere: the user pastes the code its page shows.
    let second = home.write("accounts/claude-lg-2/.keep", "").parent().expect("dir").to_string_lossy().into_owned();
    let (flow, pages, code) = start(&second, None);
    let pages = pages.await.expect("the pages");
    code.send(format!("code-2#{}", query(&pages.shown, "state"))).expect("the flow listens");
    flow.await.expect("the flow").expect("signs in");
    assert_eq!(stores.access_token("anthropic", &second).await.as_deref(), Some("at-code-2"));
    let pasted: Value = serde_json::from_str(&server.hits_to("/token")[1].body).expect("JSON");
    assert_eq!(pasted["redirect_uri"], format!("{}/code/callback", server.url));

    // A code from another sign-in is refused and leaves the store empty.
    let third = home.write("accounts/claude-lg-3/.keep", "").parent().expect("dir").to_string_lossy().into_owned();
    let (flow, _pages, code) = start(&third, None);
    code.send("code-3#not-this-sign-in".to_owned()).expect("the flow listens");
    let refused = flow.await.expect("the flow").expect_err("refused");
    assert_eq!(refused, "the sign-in failed: that code is not from this sign-in");
    assert!(!stores.read("anthropic", &third).await.present);

    // Dropping the flow cancels it: nothing listens any more.
    let (flow, pages, _code) = start(&third, None);
    let pages = pages.await.expect("the pages");
    flow.abort();
    let _ = flow.await;
    let gone = format!("{}?code=code-4&state={}", query(&pages.open, "redirect_uri"), query(&pages.open, "state"));
    assert!(reqwest::get(&gone).await.is_err(), "the loopback listener is closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chatgpt_store_is_read_and_signed_out_and_keeps_its_registration() {
    let home = TempHome::new();
    let dir = home.join("accounts/chatgpt");
    let store = dir.to_string_lossy().into_owned();
    let stores = Arc::new(Stores::new(Arc::new(NoKeychain), Endpoints::default()));
    assert_eq!(stores.read("openai", &store).await, StoreLogin::default());
    assert_eq!(stores.access_token("openai", &store).await, None);

    // The record a ChatGPT sign-in leaves in its store.
    let record = json!({
        "email": "me@example.com", "issuer": "https://auth.openai.com", "subject": "user-1", "client_id": "app-1",
        "ext_agent_host_id": "urn:uuid:1", "access_token": "at-chatgpt", "refresh_token": "rt",
        "expires_at": far_future(), "scopes": ["openid", "chatgpt.tokens.use.direct"], "saved_at": 1,
    });
    home.write("accounts/chatgpt/siwc.json", record.to_string());
    home.write("accounts/chatgpt/host-id", "urn:uuid:1");
    let read = stores.read("openai", &store).await;
    assert_eq!(read, StoreLogin { present: true, plan: None, email: Some("me@example.com".into()) });
    assert_eq!(stores.access_token("openai", &store).await.as_deref(), Some("at-chatgpt"));

    stores.sign_out("openai", &store).await.expect("signs out");
    assert!(!stores.read("openai", &store).await.present);
    assert!(dir.join("host-id").exists(), "a later sign-in is the same app registration");
    stores.sign_out("openai", &store).await.expect("twice is not an error");

    let provider = ChatGptSignIn::new(stores);
    assert!(!provider.accepts_code() && !provider.multi_login() && provider.id() == "openai");
    assert_eq!(stores_of_unknown_provider().await, StoreLogin::default());
}

async fn stores_of_unknown_provider() -> StoreLogin {
    Stores::new(Arc::new(NoKeychain), Endpoints::default()).read("gemini", "/nowhere").await
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_is_read_with_the_sign_ins_token_and_a_refusal_keeps_its_words() {
    let server = FakeServer::start(|hit| match (hit.path(), hit.headers.get("authorization").map(String::as_str)) {
        ("/api/oauth/usage", Some("Bearer good")) => (
            200,
            json!({ "five_hour": { "utilization": 41.0, "resets_at": "2026-06-08T14:00:00Z" }, "seven_day": null })
                .to_string(),
        ),
        ("/api/oauth/usage", _) => (429, r#"{"error":{"type":"rate_limit_error"}}"#.to_owned()),
        ("/v1/models", Some("Bearer good")) => (200, r#"{"data":[]}"#.to_owned()),
        ("/v1/models", Some("Bearer revoked")) => (401, "{}".to_owned()),
        _ => (500, "{}".to_owned()),
    })
    .await;
    let api = ClaudeUsageApi::at(&server.url, Arc::new(FakeClock::at(1_767_259_800_125)));

    let usage = api.fetch("good").await.expect("reads");
    assert_eq!(
        serde_json::to_value(&usage).expect("JSON"),
        json!({
            "provider": "claude",
            "windows": { "fiveHour": { "utilization": 41, "resetsAt": "2026-06-08T14:00:00Z" }, "sevenDay": null },
            "fetchedAt": "2026-01-01T09:30:00.125Z",
        })
    );
    let request = &server.hits()[0];
    assert_eq!(request.headers.get("anthropic-beta").map(String::as_str), Some("oauth-2025-04-20"));
    let agent = request.headers.get("user-agent").expect("a user agent");
    assert!(agent.starts_with("eos/"), "Eos names itself: {agent}");

    assert_eq!(
        api.fetch("other").await,
        Err(r#"usage fetch failed (HTTP 429): {"error":{"type":"rate_limit_error"}}"#.to_owned())
    );
    let nowhere = ClaudeUsageApi::at("http://127.0.0.1:1", Arc::new(FakeClock::new()));
    assert!(nowhere.fetch("good").await.is_err_and(|e| e.starts_with("usage request failed: ")));

    // infra/src/__tests__/claudeTokenProbe.test.ts
    let probe = ClaudeTokenProbe::at(&server.url);
    assert_eq!(probe.probe("good").await, TokenProbeResult::Valid);
    assert_eq!(probe.probe("revoked").await, TokenProbeResult::Rejected);
    assert_eq!(probe.probe("anything").await, TokenProbeResult::Unknown, "a server error says nothing");
    assert_eq!(ClaudeTokenProbe::at("http://127.0.0.1:1").probe("good").await, TokenProbeResult::Unknown);
    let models = server.hits_to("/v1/models");
    assert_eq!(models[0].target, "/v1/models?limit=1");
    assert_eq!(models[0].headers.get("anthropic-version").map(String::as_str), Some("2023-06-01"));
}
