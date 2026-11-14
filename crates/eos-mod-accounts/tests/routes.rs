//! The module on its own: the accounts service over fakes of everything
//! outside the process, the real store over the seeded rows, no app around it.

use std::sync::Arc;

use eos_accounts::{Accounts, CLAUDE, Deps};
use eos_core::accounts::{
    PlanFailure, PlanLimits, SessionCredential, SessionCredentials, SignedIn, SubscriptionProvider,
};
use eos_mod_accounts::AccountsModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{
    FakeBrowser, FakeClock, FakeConfig, FakeLocalTime, FakePlanLoginDirs, FakePlanLoginStore, FakePlanStores,
    FakePlanUsageApi, FakeSessionSwitch, FakeSleeper, FakeSubscriptionProvider, FakeTokenProbe, FakeUsageSnapshots,
    SeqIds, TempStore,
};
use serde_json::{Value, json};

const NOW: i64 = 1_794_398_400_000;

struct Fixture {
    runtime: Runtime,
    accounts: Arc<Accounts>,
    temp: TempStore,
    stores: Arc<FakePlanStores>,
    claude: Arc<FakeSubscriptionProvider>,
    config: Arc<FakeConfig>,
    sessions: Arc<FakeSessionSwitch>,
    sleeper: Arc<FakeSleeper>,
}

fn fixture(config: Value) -> Fixture {
    let temp = TempStore::seeded("/sandbox");
    let config = Arc::new(FakeConfig::new(config));
    let stores = Arc::new(FakePlanStores::default());
    let claude = FakeSubscriptionProvider::several("anthropic");
    let providers: Vec<Arc<dyn SubscriptionProvider>> =
        vec![claude.clone(), FakeSubscriptionProvider::single("openai")];
    let (sessions, sleeper) = (Arc::new(FakeSessionSwitch::default()), Arc::new(FakeSleeper::default()));
    let accounts = Accounts::new(Deps {
        clock: Arc::new(FakeClock::at(NOW)),
        ids: Arc::new(SeqIds::new()),
        config: config.clone(),
        store: temp.port(),
        announcer: temp.announced.clone(),
        login_store: Arc::new(FakePlanLoginStore::default()),
        dirs: Arc::new(FakePlanLoginDirs::default()),
        stores: stores.clone(),
        providers,
        browser: Arc::new(FakeBrowser::default()),
        probe: Arc::new(FakeTokenProbe::default()),
        usage_api: Arc::new(FakePlanUsageApi::default()),
        usage_cache: Arc::new(FakeUsageSnapshots::default()),
        local_time: Arc::new(FakeLocalTime),
        sleeper: sleeper.clone(),
        sessions: sessions.clone(),
    });
    let module = Arc::new(AccountsModule::new(accounts.clone(), config.clone()));
    let runtime =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");
    Fixture { runtime, accounts, temp, stores, claude, config, sessions, sleeper }
}

impl Fixture {
    async fn call(&self, method: Method, target: &str, body: Option<Value>, caller: Caller) -> (u16, Value) {
        let mut request = Request::new(method, target, caller);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let res = self.runtime.router.handle(request).await;
        let status = res.status;
        let bytes = res.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn get(&self, target: &str) -> (u16, Value) {
        self.call(Method::Get, target, None, Caller::DASHBOARD).await
    }

    async fn put(&self, target: &str, body: Value) -> (u16, Value) {
        self.call(Method::Put, target, Some(body), Caller::DASHBOARD).await
    }

    async fn post(&self, target: &str, body: Value) -> (u16, Value) {
        self.call(Method::Post, target, Some(body), Caller::DASHBOARD).await
    }

    async fn delete(&self, target: &str) -> (u16, Value) {
        self.call(Method::Delete, target, None, Caller::DASHBOARD).await
    }

    /// Signs in through the routes; returns the new sign-in's id.
    async fn sign_in(&self, email: &str) -> String {
        let (status, session) = self.post("/api/accounts/anthropic/sign-in", json!({})).await;
        assert_eq!(status, 202);
        let id = session["id"].as_str().expect("an id").to_owned();
        self.until_state(&id, "waiting").await;
        let store = self.claude.started().last().expect("a flow").store_dir.clone();
        self.stores.sign_in(&store, Some("max"), None);
        assert!(self.claude.finish(Ok(SignedIn { email: Some(email.to_owned()) })));
        self.until_state(&id, "succeeded").await;
        self.accounts.logins().list(CLAUDE).last().expect("a login").id.clone()
    }

    async fn until_state(&self, id: &str, state: &str) {
        for _ in 0..5_000 {
            if self.get(&format!("/api/sign-ins/{id}")).await.1["state"] == state {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        panic!("the sign-in never reached {state}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn accounts_need_the_users_dashboard_and_usage_is_an_open_read() {
    let t = fixture(json!({}));
    let denied = json!({ "error": "ui token required" });
    for (method, target) in [
        (Method::Get, "/api/accounts"),
        (Method::Post, "/api/accounts/anthropic/sign-in"),
        (Method::Delete, "/api/accounts/anthropic/sign-in"),
        (Method::Put, "/api/accounts/anthropic/logins/lg-1"),
        (Method::Delete, "/api/accounts/anthropic/logins/lg-1"),
        (Method::Put, "/api/accounts/anthropic/default-login"),
        (Method::Put, "/api/accounts/anthropic/auto-switch"),
        (Method::Put, "/workers/w-CHAT/plan-resume"),
        (Method::Post, "/workers/w-CHAT/api-key-continue"),
        (Method::Get, "/api/sign-ins/x"),
        (Method::Delete, "/api/sign-ins/x"),
        (Method::Post, "/api/sign-ins/x/code"),
        (Method::Get, "/api/anthropic/config"),
        (Method::Put, "/api/anthropic/config"),
    ] {
        let answer = t.call(method, target, None, Caller::UNTRUSTED).await;
        assert_eq!(answer, (403, denied.clone()), "{method:?} {target}");
    }
    let (status, usage) = t.call(Method::Get, "/api/usage", None, Caller::UNTRUSTED).await;
    assert_eq!(status, 200);
    // The recorded signed-out answer (fixtures/wire/recordings/15-accounts.json, "usage").
    let recorded = eos_testkit::fixtures::recorded_response("15-accounts", "usage");
    assert_eq!(usage, recorded["json"]);
    assert_eq!(t.get("/api/usage?wait=1").await.1, recorded["json"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_runs_through_its_routes_and_the_list_shows_it_redacted() {
    let t = fixture(json!({}));
    let (status, session) = t.post("/api/accounts/anthropic/sign-in", json!({})).await;
    assert_eq!(status, 202);
    assert_eq!(session["provider"], "anthropic");
    assert_eq!(session["codeEntry"], true);
    let id = session["id"].as_str().expect("an id").to_owned();
    t.until_state(&id, "waiting").await;
    let (_, waiting) = t.get(&format!("/api/sign-ins/{id}")).await;
    assert_eq!(waiting["url"], "https://anthropic.example/authorize?to=code");

    let code = format!("/api/sign-ins/{id}/code");
    assert_eq!(t.post(&code, json!({ "code": "  " })).await.0, 400);
    let (status, after_code) = t.post(&code, json!({ "code": "abc#state" })).await;
    assert_eq!((status, after_code["state"].as_str()), (200, Some("waiting")));
    assert_eq!(
        t.post(&code, json!({ "code": "again" })).await,
        (409, json!({ "error": "sign-in is not waiting for a code" }))
    );

    let store = t.claude.started()[0].store_dir.clone();
    t.stores.sign_in(&store, Some("max"), None);
    assert!(t.claude.finish(Ok(SignedIn { email: Some("me@example.com".into()) })));
    t.until_state(&id, "succeeded").await;
    // A sign-in that already ended cannot be cancelled: 404 with its last state.
    let (status, ended) = t.delete(&format!("/api/sign-ins/{id}")).await;
    assert_eq!((status, ended["state"].as_str()), (404, Some("succeeded")));

    let login = t.accounts.logins().list(CLAUDE)[0].id.clone();
    t.accounts
        .launched("w-CHAT", Some(&SessionCredential::Store { provider: CLAUDE.into(), dir: store.clone().into() }));
    let (status, list) = t.get("/api/accounts").await;
    assert_eq!(status, 200);
    assert_eq!(
        list["accounts"][0],
        json!({
            "id": "anthropic", "label": "Claude",
            "subscription": { "supported": true, "state": "signed_in", "source": "eos", "plan": "max" },
            "apiKey": { "set": false }, "route": "subscription",
            "logins": [{ "id": login, "label": "me@example.com", "email": "me@example.com", "plan": "max", "state": "signed_in", "inUse": 1 }],
            "defaultLoginId": login, "autoSwitch": true,
        })
    );
    let text = list.to_string();
    assert!(!text.contains(&store) && !text.contains("token-of"), "no store path or token leaves the app");

    // A second sign-in can be started and cancelled while it waits.
    let (_, second) = t.post("/api/accounts/anthropic/sign-in", json!({ "loginId": login })).await;
    assert_eq!(second["loginId"], login);
    let second_id = second["id"].as_str().expect("an id");
    let (status, cancelled) = t.delete(&format!("/api/sign-ins/{second_id}")).await;
    assert_eq!((status, cancelled["state"].as_str()), (200, Some("cancelled")));
    assert_eq!(t.post("/api/accounts/anthropic/sign-in", json!({ "loginId": "nope" })).await.0, 404);
    assert_eq!(t.post("/api/accounts/anthropic/sign-in", json!({ "extra": 1 })).await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_ins_are_renamed_made_default_removed_and_signed_out() {
    let t = fixture(json!({}));
    let (first, second) = (t.sign_in("a@example.com").await, t.sign_in("b@example.com").await);
    let ok = (200, json!({ "ok": true }));

    assert_eq!(t.put(&format!("/api/accounts/anthropic/logins/{second}"), json!({ "label": " Work " })).await, ok);
    assert_eq!(t.put("/api/accounts/anthropic/default-login", json!({ "loginId": second })).await, ok);
    assert_eq!(t.put("/api/accounts/anthropic/auto-switch", json!({ "enabled": false })).await, ok);
    let (_, list) = t.get("/api/accounts").await;
    let claude = &list["accounts"][0];
    assert_eq!(claude["logins"][1]["label"], "Work");
    assert_eq!(
        (claude["defaultLoginId"].as_str(), claude["autoSwitch"].as_bool()),
        (Some(second.as_str()), Some(false))
    );

    assert_eq!(t.put("/api/accounts/anthropic/logins/nope", json!({ "label": "" })).await.0, 400);
    assert_eq!(
        t.put("/api/accounts/openai/default-login", json!({ "loginId": first })).await,
        (404, json!({ "error": "\"openai\" holds a single sign-in" }))
    );

    assert_eq!(t.delete(&format!("/api/accounts/anthropic/logins/{second}")).await, ok);
    let (_, list) = t.get("/api/accounts").await;
    assert_eq!(list["accounts"][0]["defaultLoginId"], first.as_str(), "the default went to the one left");
    assert_eq!(t.stores.signed_out().len(), 1);

    assert_eq!(t.delete("/api/accounts/anthropic/sign-in").await, ok);
    let (_, list) = t.get("/api/accounts").await;
    assert_eq!(list["accounts"][0]["logins"], json!([]));
    assert_eq!(list["accounts"][0]["subscription"], json!({ "supported": true, "state": "signed_out" }));
    assert_eq!(
        t.delete("/api/accounts/xai/sign-in").await,
        (404, json!({ "error": "sign-in is not supported for \"xai\"" }))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_exhausted_rows_actions_schedule_a_resume_or_move_to_the_api_key() {
    let t = fixture(json!({}));
    let login = t.sign_in("a@example.com").await;
    let dir = t.accounts.logins().list(CLAUDE)[0].store_dir.clone();
    t.accounts.launched("w-CHAT", Some(&SessionCredential::Store { provider: CLAUDE.into(), dir: dir.into() }));
    let limits = PlanLimits { resets_at_ms: Some(NOW + 60_000), ..PlanLimits::default() };
    t.accounts.failed("w-CHAT", &PlanFailure::LimitReached(limits)).await;
    let row = t
        .temp
        .store
        .read_blocking(|tx| tx.events().list_by_type("w-CHAT", eos_contracts::WorkerEventType::AccountsExhausted, None))
        .expect("reads")[0]
        .id;

    let ok = (200, json!({ "ok": true }));
    assert_eq!(t.put("/workers/w-CHAT/plan-resume", json!({ "rowId": row, "on": true })).await, ok);
    assert_eq!(t.sleeper.pending(), [60_000 + 30_000]);
    assert_eq!(t.put("/workers/w-CHAT/plan-resume", json!({ "rowId": row, "on": false })).await, ok);
    assert_eq!(
        t.put("/workers/w-CHAT/plan-resume", json!({ "rowId": 999_999, "on": true })).await,
        (409, json!({ "error": "not an exhausted-accounts row" }))
    );
    assert_eq!(t.put("/workers/w-CHAT/plan-resume", json!({ "rowId": 0, "on": true })).await.0, 400);

    assert_eq!(
        t.post("/workers/w-CHAT/api-key-continue", json!({})).await,
        (409, json!({ "error": "No API key is set — add one in Settings › Accounts." }))
    );
    // The key is set through its own route, redacted both ways.
    assert_eq!(
        t.put("/api/anthropic/config", json!({ "apiKey": "sk-ant-api03-wxyz" })).await,
        (200, json!({ "apiKeySet": true, "authTokenSet": false }))
    );
    assert_eq!(t.config.file(), json!({ "anthropic": { "apiKey": "sk-ant-api03-wxyz" } }));
    let (_, list) = t.get("/api/accounts").await;
    assert_eq!(list["accounts"][0]["apiKey"], json!({ "set": true, "hint": "wxyz" }));
    assert_eq!(list["accounts"][0]["route"], "subscription", "the sign-in still pays");
    assert_eq!(t.post("/workers/w-CHAT/api-key-continue", json!({})).await, ok);
    let key = SessionCredential::ApiKey { provider: CLAUDE.into(), key: "sk-ant-api03-wxyz".into() };
    assert_eq!(t.sessions.moves(), [("w-CHAT".to_owned(), key)]);

    // A blank value clears the field; an unknown one is refused.
    assert_eq!(
        t.put("/api/anthropic/config", json!({ "apiKey": "  " })).await,
        (200, json!({ "apiKeySet": false, "authTokenSet": false }))
    );
    assert_eq!(t.config.file(), json!({ "anthropic": {} }));
    assert_eq!(t.put("/api/anthropic/config", json!({ "apiKeys": "x" })).await.0, 400);
    assert_eq!(t.get("/api/anthropic/config").await, (200, json!({ "apiKeySet": false, "authTokenSet": false })));
    let _ = login;
}
