//! The accounts as one unit, over the real store and fakes of everything
//! outside the process.

use std::sync::Arc;

use eos_contracts::{BillingRoute, SignInState, SubscriptionState};
use eos_core::accounts::{
    PlanFailure, PlanLimits, PlanVerdict, SessionCredential, SessionCredentials, SignedIn, SubscriptionProvider,
    TokenProbeResult,
};
use eos_core::store::EventOrder;
use eos_domain::accounts::PlanLoginRecord;
use eos_testkit::{
    FakeBrowser, FakeClock, FakeConfig, FakeLocalTime, FakePlanLoginDirs, FakePlanLoginStore, FakePlanStores,
    FakePlanUsageApi, FakeSessionSwitch, FakeSleeper, FakeSubscriptionProvider, FakeTokenProbe, FakeUsageSnapshots,
    SeqIds, TempStore,
};
use serde_json::{Value, json};

use super::*;

/// 2026-11-11T12:00:00Z.
const NOW: i64 = 1_794_398_400_000;
/// 16:40 the same day.
const RESET: i64 = NOW + 4 * 3_600_000 + 40 * 60_000;
const WORKER: &str = "w-CHAT";

struct Fixture {
    accounts: Arc<Accounts>,
    temp: TempStore,
    clock: Arc<FakeClock>,
    config: Arc<FakeConfig>,
    stores: Arc<FakePlanStores>,
    dirs: Arc<FakePlanLoginDirs>,
    claude: Arc<FakeSubscriptionProvider>,
    chatgpt: Arc<FakeSubscriptionProvider>,
    browser: Arc<FakeBrowser>,
    probe: Arc<FakeTokenProbe>,
    usage_api: Arc<FakePlanUsageApi>,
    sessions: Arc<FakeSessionSwitch>,
    sleeper: Arc<FakeSleeper>,
}

fn fixture(config: Value) -> Fixture {
    let temp = TempStore::seeded("/sandbox");
    let clock = Arc::new(FakeClock::at(NOW));
    let config = Arc::new(FakeConfig::new(config));
    let (stores, dirs) = (Arc::new(FakePlanStores::default()), Arc::new(FakePlanLoginDirs::default()));
    let (claude, chatgpt) =
        (FakeSubscriptionProvider::several("anthropic"), FakeSubscriptionProvider::single("openai"));
    let (browser, probe) = (Arc::new(FakeBrowser::default()), Arc::new(FakeTokenProbe::default()));
    let (usage_api, sessions) = (Arc::new(FakePlanUsageApi::default()), Arc::new(FakeSessionSwitch::default()));
    let sleeper = Arc::new(FakeSleeper::default());
    let providers: Vec<Arc<dyn SubscriptionProvider>> = vec![claude.clone(), chatgpt.clone()];
    let accounts = Accounts::new(Deps {
        clock: clock.clone(),
        ids: Arc::new(SeqIds::new()),
        config: config.clone(),
        store: temp.port(),
        announcer: temp.announced.clone(),
        login_store: Arc::new(FakePlanLoginStore::default()),
        dirs: dirs.clone(),
        stores: stores.clone(),
        providers,
        browser: browser.clone(),
        probe: probe.clone(),
        usage_api: usage_api.clone(),
        usage_cache: Arc::new(FakeUsageSnapshots::default()),
        local_time: Arc::new(FakeLocalTime),
        sleeper: sleeper.clone(),
        sessions: sessions.clone(),
    });
    Fixture {
        accounts,
        temp,
        clock,
        config,
        stores,
        dirs,
        claude,
        chatgpt,
        browser,
        probe,
        usage_api,
        sessions,
        sleeper,
    }
}

impl Fixture {
    /// Adds a signed-in Claude sign-in.
    fn login(&self, email: &str) -> PlanLoginRecord {
        let logins = self.accounts.logins();
        let target = logins.prepare(CLAUDE, None).expect("a fresh store");
        self.stores.sign_in(&target.store_dir, Some("max"), Some(email));
        logins.commit(&target, Some(email)).expect("commits").login
    }

    fn run_on(&self, login: &PlanLoginRecord) {
        self.accounts.launched(WORKER, Some(&store(&login.store_dir)));
    }

    async fn limit(&self) -> PlanVerdict {
        let limits = PlanLimits { status: Some("rejected".into()), resets_at_ms: Some(RESET), ..PlanLimits::default() };
        self.accounts.failed(WORKER, &PlanFailure::LimitReached(limits)).await
    }

    /// The worker's rows of one kind, as `(id, payload)`.
    fn rows(&self, kind: &str) -> Vec<(i64, Value)> {
        let all = self
            .temp
            .store
            .read_blocking(|tx| {
                tx.events().list(&eos_core::store::EventQuery {
                    worker_id: WORKER.into(),
                    since: 0,
                    limit: 1_000,
                    order: EventOrder::Asc,
                    before_id: None,
                    after_id: Some(0),
                })
            })
            .expect("reads");
        all.into_iter()
            .filter(|e| e.kind == kind)
            .map(|e| (e.id, serde_json::from_str(e.payload.as_deref().unwrap_or("null")).expect("JSON")))
            .collect()
    }

    fn announced(&self, topic: &str) -> Vec<Value> {
        let list = self.temp.announced.list();
        list.iter().filter(|(t, _)| *t == topic).map(|(_, p)| serde_json::from_str(p).expect("JSON")).collect()
    }

    async fn claude_status(&self) -> eos_contracts::AccountStatus {
        self.accounts.status().list().await.remove(0)
    }
}

fn store(dir: &str) -> SessionCredential {
    SessionCredential::Store { provider: CLAUDE.into(), dir: dir.into() }
}

/// Waits for something another task does.
async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..5_000 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("never happened: {what}");
}

// ---- core/src/__tests__/SwitchSessionAccount.test.ts ---------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_limit_moves_the_session_to_the_next_sign_in_and_records_the_switch() {
    let t = fixture(json!({}));
    let (personal, work) = (t.login("p@example.com"), t.login("w@example.com"));
    t.run_on(&personal);

    assert_eq!(t.limit().await, PlanVerdict::Switch(store(&work.store_dir)));
    let rows = t.rows("account_switched");
    assert_eq!(
        rows[0].1,
        json!({ "provider": "anthropic", "from": "p@example.com", "to": "w@example.com", "reason": "limit", "resetsAt": "2026-11-11T16:40:00.000Z" })
    );
    assert_eq!(t.announced("worker:change"), [json!({ "workerId": WORKER, "rowId": rows[0].0 })]);
    let status = t.claude_status().await;
    let logins = status.logins.expect("logins");
    assert_eq!(logins[0].limited_until.as_deref(), Some("2026-11-11T16:40:00.000Z"));
    assert_eq!((logins[0].in_use, logins[1].in_use), (None, Some(1)), "the session now counts on the other sign-in");
    assert_eq!(
        t.accounts.for_new_session(CLAUDE).await,
        Some(store(&work.store_dir)),
        "new sessions skip the limited default"
    );
    assert!(t.sessions.moves().is_empty(), "the engine re-sends the request itself");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_switch_goes_to_the_sign_in_with_the_most_room() {
    let t = fixture(json!({}));
    let (personal, work, spare) = (t.login("p@example.com"), t.login("w@example.com"), t.login("s@example.com"));
    // `work` has used 41% of its five-hour window, `spare` 10%.
    let mut light = eos_testkit::FakeUsageProvider::snapshot("claude", None);
    if let Some(Some(window)) = &mut light.windows.five_hour {
        window.utilization = 10.0.into();
    }
    t.usage_api.answer_for(&format!("token-of:{}", spare.store_dir), Ok(light));
    t.accounts.usage().get_usage().await;
    assert_eq!(t.usage_api.tokens().len(), 3, "each sign-in is read with its own token");
    t.run_on(&personal);
    assert_eq!(t.limit().await, PlanVerdict::Switch(store(&spare.store_dir)));

    // With nothing known about either, a sign-in that is not the default
    // hands over to the default.
    let t = fixture(json!({}));
    let (personal, work_only) = (t.login("p@example.com"), t.login("w@example.com"));
    t.run_on(&work_only);
    assert_eq!(t.limit().await, PlanVerdict::Switch(store(&personal.store_dir)));
    let _ = work;
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_other_sign_in_ready_the_row_and_the_banner_say_so() {
    let t = fixture(json!({ "anthropic": { "apiKey": "sk-ant-1234" } }));
    let personal = t.login("p@example.com");
    t.run_on(&personal);

    assert_eq!(t.limit().await, PlanVerdict::Exhausted);
    let rows = t.rows("accounts_exhausted");
    assert_eq!(
        rows[0].1,
        json!({ "provider": "anthropic", "nextResetAt": "2026-11-11T16:40:00.000Z", "apiKey": true })
    );
    assert_eq!(
        t.announced("notification:fire"),
        [json!({
            "title": "Claude accounts are out",
            "body": "Fix the parser stopped — the next limit resets at 16:40.",
            "workerId": WORKER,
            "ts": NOW,
        })]
    );
    assert!(t.rows("account_switched").is_empty());
    assert_eq!(
        t.accounts.for_new_session(CLAUDE).await,
        Some(store(&personal.store_dir)),
        "with every sign-in at its limit a limited one still starts sessions"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_ins_that_stopped_working_leave_no_reset_to_wait_for() {
    let t = fixture(json!({}));
    let (personal, work) = (t.login("p@example.com"), t.login("w@example.com"));
    t.run_on(&personal);
    let expired = PlanFailure::Expired("sign-in renewal refused".into());

    assert_eq!(t.accounts.failed(WORKER, &expired).await, PlanVerdict::Switch(store(&work.store_dir)));
    assert_eq!(
        t.rows("account_switched")[0].1,
        json!({ "provider": "anthropic", "from": "p@example.com", "to": "w@example.com", "reason": "expired" })
    );
    assert_eq!(t.claude_status().await.logins.expect("logins")[0].state, SubscriptionState::Expired);

    assert_eq!(t.accounts.failed(WORKER, &expired).await, PlanVerdict::Exhausted);
    assert_eq!(t.rows("accounts_exhausted")[0].1, json!({ "provider": "anthropic", "apiKey": false }));
    assert_eq!(t.announced("notification:fire")[0]["body"], "Fix the parser stopped — sign in again to continue.");
    let status = t.claude_status().await;
    assert_eq!(status.subscription.map(|s| s.state), Some(SubscriptionState::Expired));
    assert_eq!(status.route, BillingRoute::Blocked, "no fallback to a key");
    assert_eq!(t.accounts.for_new_session(CLAUDE).await, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_switch_off_only_sets_the_sign_in_aside_and_unknown_stores_change_nothing() {
    let t = fixture(json!({}));
    let (personal, _work) = (t.login("p@example.com"), t.login("w@example.com"));
    assert_eq!(t.limit().await, PlanVerdict::Keep, "a worker with no session");
    t.accounts.launched(WORKER, Some(&store("/elsewhere")));
    assert_eq!(t.limit().await, PlanVerdict::Keep, "a store that is not listed");
    let key = SessionCredential::ApiKey { provider: CLAUDE.into(), key: "sk".into() };
    t.accounts.launched(WORKER, Some(&key));
    assert_eq!(t.limit().await, PlanVerdict::Keep, "a session on a key");
    assert_eq!(t.accounts.ledger().blocked(&personal.id), None);

    t.accounts.logins().set_auto_switch(CLAUDE, false).expect("saves");
    t.run_on(&personal);
    assert_eq!(t.limit().await, PlanVerdict::Keep);
    assert!(t.accounts.ledger().blocked(&personal.id).is_some(), "set aside all the same");
    assert!(t.rows("account_switched").is_empty() && t.rows("accounts_exhausted").is_empty());

    t.accounts.launched(WORKER, None);
    assert_eq!(t.claude_status().await.logins.expect("logins")[0].in_use, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_api_key_takes_a_session_over_only_when_one_is_set() {
    let t = fixture(json!({}));
    assert_eq!(
        t.accounts.continue_on_api_key(WORKER).await,
        Err("No API key is set — add one in Settings › Accounts.".to_owned())
    );

    let t = fixture(json!({ "anthropic": { "apiKey": " sk-ant-1234 " } }));
    assert_eq!(t.accounts.continue_on_api_key(WORKER).await, Ok(()));
    let key = SessionCredential::ApiKey { provider: CLAUDE.into(), key: "sk-ant-1234".into() };
    assert_eq!(t.sessions.moves(), [(WORKER.to_owned(), key)]);
    assert_eq!(
        t.rows("account_switched")[0].1,
        json!({ "provider": "anthropic", "to": "API key", "reason": "api_key" })
    );

    t.sessions.refuse("this agent can't change account right now");
    assert_eq!(
        t.accounts.continue_on_api_key(WORKER).await,
        Err("this agent can't change account right now".to_owned())
    );
    assert_eq!(t.rows("account_switched").len(), 1, "a move that failed records nothing");
}

// ---- manager/services/__tests__/PlanResumeService.test.ts ----------------------

async fn exhausted(t: &Fixture) -> (PlanLoginRecord, i64) {
    let personal = t.login("p@example.com");
    t.run_on(&personal);
    assert_eq!(t.limit().await, PlanVerdict::Exhausted);
    t.temp.exec("UPDATE workers SET state = 'IDLE' WHERE id = 'w-CHAT'");
    (personal, t.rows("accounts_exhausted")[0].0)
}

impl Fixture {
    /// Lets the pending resume timer fire and waits until the row shows its end.
    async fn fire_resume(&self) {
        assert!(self.sleeper.wake());
        while self.rows("accounts_exhausted")[0].1.get("resumeAt").is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_waits_for_the_reset_then_moves_the_session_to_the_sign_in_that_came_back() {
    let t = fixture(json!({}));
    let (personal, row) = exhausted(&t).await;
    let resume = t.accounts.resume();

    assert_eq!(resume.schedule(WORKER, row).await, Ok(()));
    assert_eq!(t.sleeper.pending(), [RESET - NOW + 30_000], "the reset plus the slack");
    assert_eq!(t.rows("accounts_exhausted")[0].1["resumeAt"], "2026-11-11T16:40:00.000Z");
    assert!(t.sessions.moves().is_empty());

    t.clock.set(RESET + 30_000);
    t.fire_resume().await;
    assert_eq!(t.sessions.moves(), [(WORKER.to_owned(), store(&personal.store_dir))]);
    let payload = &t.rows("accounts_exhausted")[0].1;
    assert_eq!((payload["resumed"].clone(), payload.get("resumeAt")), (json!(true), None));
    assert_eq!(
        t.rows("account_switched")[0].1,
        json!({ "provider": "anthropic", "to": "p@example.com", "reason": "reset" })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_stands_down_when_the_user_went_on_or_no_sign_in_is_ready() {
    let t = fixture(json!({}));
    let (_personal, row) = exhausted(&t).await;
    let resume = t.accounts.resume();

    // Cancelled: the schedule leaves the row and the timer is dropped.
    assert_eq!(resume.schedule(WORKER, row).await, Ok(()));
    resume.cancel(WORKER, row).await;
    assert_eq!(t.rows("accounts_exhausted")[0].1.get("resumeAt"), None);
    until("the timer is dropped", || t.sleeper.pending().is_empty()).await;

    // The limit has not lifted when the timer fires (the clock did not move).
    assert_eq!(resume.schedule(WORKER, row).await, Ok(()));
    t.fire_resume().await;
    assert!(t.sessions.moves().is_empty());
    assert_eq!(t.rows("accounts_exhausted")[0].1.get("resumed"), None);

    // The user sent something since the row.
    t.clock.set(RESET + 30_000);
    t.temp.exec(
        "INSERT INTO events (worker_id, ts, type, payload) VALUES ('w-CHAT', 1, 'user_message', '{\"text\":\"hi\"}')",
    );
    assert_eq!(resume.schedule(WORKER, row).await, Ok(()));
    assert_eq!(t.sleeper.pending(), [30_000], "a reset in the past waits only the slack");
    t.fire_resume().await;
    assert!(t.sessions.moves().is_empty());

    // The agent is busy.
    t.temp.exec("DELETE FROM events WHERE worker_id = 'w-CHAT' AND ts = 1");
    t.temp.exec("UPDATE workers SET state = 'WORKING' WHERE id = 'w-CHAT'");
    assert_eq!(resume.schedule(WORKER, row).await, Ok(()));
    t.fire_resume().await;
    assert!(t.sessions.moves().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn rows_that_cannot_be_resumed_are_refused() {
    let t = fixture(json!({}));
    let resume = t.accounts.resume();
    assert_eq!(resume.schedule(WORKER, 999_999).await, Err("not an exhausted-accounts row".to_owned()));
    let other = t.rows("user_message")[0].0;
    assert_eq!(resume.schedule(WORKER, other).await, Err("not an exhausted-accounts row".to_owned()));

    let personal = t.login("p@example.com");
    t.run_on(&personal);
    t.accounts.failed(WORKER, &PlanFailure::Expired("revoked".into())).await;
    let row = t.rows("accounts_exhausted")[0].0;
    assert_eq!(
        resume.schedule(WORKER, row).await,
        Err("no limit reset to wait for — sign in again instead".to_owned())
    );
    assert_eq!(resume.schedule("w-BARE", row).await, Err("not an exhausted-accounts row".to_owned()));
}

// ---- manager/services/__tests__/SignInService.test.ts --------------------------

impl Fixture {
    async fn state(&self, id: &str, state: SignInState) {
        let sign_ins = self.accounts.sign_ins();
        until("the sign-in changes state", || sign_ins.get(id).map(|s| s.state) == Some(state)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_goes_from_starting_to_waiting_to_succeeded_and_adds_the_login() {
    let t = fixture(json!({ "anthropic": { "authToken": "old-setup-token" } }));
    let sign_ins = t.accounts.sign_ins();
    let session = sign_ins.start(CLAUDE, None).expect("starts");
    assert_eq!((session.code_entry, session.login_id.clone()), (Some(true), None));
    assert_eq!(session.id.len(), 16);
    t.state(&session.id, SignInState::Waiting).await;

    let waiting = sign_ins.get(&session.id).expect("the session");
    assert_eq!(waiting.url.as_deref(), Some("https://anthropic.example/authorize?to=code"), "the link the UI offers");
    until("the browser opens", || !t.browser.opened().is_empty()).await;
    assert_eq!(t.browser.opened(), ["https://anthropic.example/authorize?to=loopback"]);
    let store_dir = t.claude.started()[0].store_dir.clone();
    assert!(store_dir.starts_with("/acc/claude-lg-"));

    assert!(sign_ins.submit_code(&session.id, " abc#state "));
    assert!(!sign_ins.submit_code(&session.id, "again"), "one code per sign-in");
    until("the code arrives", || !t.claude.codes().is_empty()).await;
    assert_eq!(t.claude.codes(), ["abc#state"]);

    t.stores.sign_in(&store_dir, Some("max"), None);
    assert!(t.claude.finish(Ok(SignedIn { email: Some("me@example.com".into()) })));
    t.state(&session.id, SignInState::Succeeded).await;
    let logins = t.accounts.logins().list(CLAUDE);
    assert_eq!((logins[0].label.as_str(), logins[0].store_dir.as_str()), ("me@example.com", store_dir.as_str()));
    assert_eq!(t.config.file()["anthropic"].get("authToken"), None, "the old setup-token is retired");
    assert!(!sign_ins.submit_code(&session.id, "late"), "a finished sign-in takes no code");
    assert!(!sign_ins.cancel(&session.id));

    let status = t.claude_status().await;
    assert_eq!(status.subscription.and_then(|s| s.plan).as_deref(), Some("max"));
    assert_eq!(status.default_login_id.as_deref(), Some(logins[0].id.as_str()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_or_cancelled_sign_in_leaves_no_store_and_a_second_start_cancels_the_first() {
    let t = fixture(json!({}));
    let sign_ins = t.accounts.sign_ins();
    let first = sign_ins.start(CLAUDE, None).expect("starts");
    t.state(&first.id, SignInState::Waiting).await;
    let second = sign_ins.start(CLAUDE, None).expect("starts");
    assert_eq!(sign_ins.get(&first.id).map(|s| s.state), Some(SignInState::Cancelled));
    t.state(&second.id, SignInState::Waiting).await;
    until("the first flow stops", || t.claude.running() == 1).await;
    assert_eq!(t.dirs.discarded(), [t.claude.started()[0].store_dir.clone()]);

    assert!(t.claude.finish(Err("Sign-in timed out. Try again.".into())));
    t.state(&second.id, SignInState::Failed).await;
    assert_eq!(sign_ins.get(&second.id).and_then(|s| s.error).as_deref(), Some("Sign-in timed out. Try again."));
    assert_eq!(t.dirs.discarded().len(), 2);
    assert!(t.accounts.logins().list(CLAUDE).is_empty());

    // Cancelling stops the flow: a late answer has nobody to go to.
    let third = sign_ins.start(CLAUDE, None).expect("starts");
    t.state(&third.id, SignInState::Waiting).await;
    assert!(sign_ins.cancel(&third.id));
    until("the cancelled flow stops", || t.claude.running() == 0).await;
    assert!(!t.claude.finish(Ok(SignedIn::default())));
    assert!(t.accounts.logins().list(CLAUDE).is_empty());
    assert!(sign_ins.start("xai", None).is_err());
    assert!(sign_ins.get("nope").is_none() && !sign_ins.cancel("nope") && !sign_ins.submit_code("nope", "x"));
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_in_again_renews_in_place_and_a_fresh_sign_in_to_a_listed_account_replaces_its_store() {
    let t = fixture(json!({}));
    let sign_ins = t.accounts.sign_ins();
    let me = t.login("me@example.com");
    t.accounts.ledger().mark(&me.id, eos_domain::accounts::PlanLimitReason::Expired, None);

    let renewal = sign_ins.start(CLAUDE, Some(&me.id)).expect("starts");
    assert_eq!(renewal.login_id.as_deref(), Some(me.id.as_str()));
    t.state(&renewal.id, SignInState::Waiting).await;
    let started = t.claude.started();
    assert_eq!(started[0].store_dir, me.store_dir, "its own store");
    assert_eq!(started[0].login_hint.as_deref(), Some("me@example.com"));
    assert!(t.claude.finish(Ok(SignedIn { email: Some("me@example.com".into()) })));
    t.state(&renewal.id, SignInState::Succeeded).await;
    assert_eq!(t.accounts.ledger().blocked(&me.id), None, "signed in again: it can run");
    assert!(t.dirs.discarded().is_empty());
    assert!(sign_ins.start(CLAUDE, Some("nope")).is_err());

    let fresh_session = sign_ins.start(CLAUDE, None).expect("starts");
    t.state(&fresh_session.id, SignInState::Waiting).await;
    let fresh = t.claude.started()[1].store_dir.clone();
    t.stores.sign_in(&fresh, Some("max"), None);
    assert!(t.claude.finish(Ok(SignedIn { email: Some("ME@example.com".into()) })));
    t.state(&fresh_session.id, SignInState::Succeeded).await;
    let logins = t.accounts.logins().list(CLAUDE);
    assert_eq!(logins.len(), 1, "the same account, not a second sign-in");
    assert_eq!((logins[0].id.as_str(), logins[0].store_dir.as_str()), (me.id.as_str(), fresh.as_str()));
    assert_eq!(t.stores.signed_out(), std::slice::from_ref(&me.store_dir), "the store it replaced is signed out");
    assert_eq!(t.dirs.trashed(), [me.store_dir]);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_sign_in_is_removed_or_the_provider_is_signed_out_of_all() {
    let t = fixture(json!({ "anthropic": { "authToken": "old" } }));
    let sign_ins = t.accounts.sign_ins();
    let (a, b, c) = (t.login("a@example.com"), t.login("b@example.com"), t.login("c@example.com"));
    assert!(sign_ins.holds_several(CLAUDE) && !sign_ins.holds_several(CHATGPT) && sign_ins.supports(CHATGPT));

    sign_ins.remove_login(CLAUDE, &a.id).await.expect("removes");
    assert_eq!(t.stores.signed_out(), std::slice::from_ref(&a.store_dir));
    assert_eq!(t.dirs.trashed(), [a.store_dir]);
    assert_eq!(
        sign_ins.remove_login(CLAUDE, "nope").await.map_err(|e| e.to_string()),
        Err("sign-in not found: nope".to_owned())
    );

    sign_ins.sign_out(CLAUDE).await.expect("signs out");
    assert!(t.accounts.logins().list(CLAUDE).is_empty());
    assert_eq!(t.dirs.trashed().len(), 3);
    assert_eq!(t.config.file()["anthropic"].get("authToken"), None);
    let _ = (b, c);

    // A provider with one sign-in keeps it in its own store.
    let session = sign_ins.start(CHATGPT, None).expect("starts");
    assert_eq!(session.code_entry, Some(false));
    t.state(&session.id, SignInState::Waiting).await;
    assert_eq!(t.chatgpt.started()[0].store_dir, "/acc/chatgpt");
    t.stores.sign_in("/acc/chatgpt", None, Some("me@example.com"));
    assert!(t.chatgpt.finish(Ok(SignedIn::default())));
    t.state(&session.id, SignInState::Succeeded).await;
    let openai = t.accounts.status().list().await.remove(1);
    assert_eq!(openai.subscription.as_ref().map(|s| s.state), Some(SubscriptionState::SignedIn));
    assert_eq!((openai.route, openai.logins), (BillingRoute::Subscription, None));
    assert_eq!(
        t.accounts.for_new_session(CHATGPT).await,
        Some(SessionCredential::Store { provider: CHATGPT.into(), dir: "/acc/chatgpt".into() })
    );
    sign_ins.sign_out(CHATGPT).await.expect("signs out");
    assert_eq!(t.accounts.for_new_session(CHATGPT).await, None);
}

// The TypeScript app kept its ChatGPT sign-in in the Codex CLI's home, which
// this app cannot use: Settings › Accounts asks for a new sign-in ("Sign-in
// expired · Sign in again") until the user signs in or out here.
#[tokio::test(flavor = "multi_thread")]
async fn a_chatgpt_sign_in_the_typescript_app_left_asks_for_a_new_one() {
    let t = fixture(json!({}));
    t.stores.left_behind("/acc/chatgpt");
    let openai = t.accounts.status().list().await.remove(1);
    assert_eq!(openai.subscription.as_ref().map(|s| s.state), Some(SubscriptionState::Expired));
    assert_eq!(openai.route, BillingRoute::Blocked);
    assert_eq!(t.accounts.for_new_session(CHATGPT).await, None, "nothing runs on it");

    t.accounts.sign_ins().sign_out(CHATGPT).await.expect("signs out");
    let openai = t.accounts.status().list().await.remove(1);
    assert_eq!(openai.subscription.as_ref().map(|s| s.state), Some(SubscriptionState::SignedOut));
    assert_eq!(openai.route, BillingRoute::None);
}

// ---- manager/services/__tests__/AccountsService.test.ts ------------------------

#[tokio::test(flavor = "multi_thread")]
async fn signed_out_bills_the_key_when_set_and_an_old_setup_token_is_probed() {
    let t = fixture(json!({}));
    let status = t.claude_status().await;
    assert_eq!(
        serde_json::to_value(&status).expect("JSON"),
        json!({
            "id": "anthropic", "label": "Claude",
            "subscription": { "supported": true, "state": "signed_out" },
            "apiKey": { "set": false }, "route": "none", "logins": [], "autoSwitch": true,
        })
    );
    assert_eq!(t.accounts.for_new_session(CLAUDE).await, None);

    let t = fixture(json!({ "anthropic": { "apiKey": "sk-ant-api03-abcd1234" } }));
    let status = t.claude_status().await;
    assert_eq!((status.route, status.api_key.hint.as_deref()), (BillingRoute::ApiKey, Some("1234")));
    assert!(matches!(t.accounts.for_new_session(CLAUDE).await, Some(SessionCredential::ApiKey { .. })));

    // A setup-token from before sign-ins had stores: signed in while the API
    // accepts it, also when the API cannot be reached; expired once rejected.
    let t = fixture(json!({ "anthropic": { "apiKey": "sk", "authToken": "setup" } }));
    assert_eq!(t.claude_status().await.route, BillingRoute::Subscription);
    assert_eq!(t.claude_status().await.route, BillingRoute::Subscription);
    assert_eq!(t.probe.calls(), 1, "the answer is kept for ten minutes");
    assert!(matches!(t.accounts.for_new_session(CLAUDE).await, Some(SessionCredential::Bearer { .. })));
    t.probe.answer(TokenProbeResult::Unknown);
    t.clock.advance(10 * 60_000);
    assert_eq!(t.claude_status().await.route, BillingRoute::Subscription);
    assert_eq!(t.claude_status().await.route, BillingRoute::Subscription);
    assert_eq!(t.probe.calls(), 3, "an unknown answer is not kept");
    t.probe.answer(TokenProbeResult::Rejected);
    let status = t.claude_status().await;
    assert_eq!(status.subscription.map(|s| s.state), Some(SubscriptionState::Expired));
    assert_eq!(status.route, BillingRoute::Blocked);
    t.accounts.status().invalidate();
    t.probe.answer(TokenProbeResult::Valid);
    assert_eq!(t.claude_status().await.route, BillingRoute::Subscription);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_sign_in_is_listed_and_the_one_new_sessions_start_on_is_billed() {
    let t = fixture(json!({ "anthropic": { "apiKey": "sk-ant-1234" } }));
    let (personal, work) = (t.login("p@example.com"), t.login("w@example.com"));
    t.accounts.logins().rename(CLAUDE, &work.id, "Work").expect("renames");
    t.run_on(&work);
    t.accounts.launched("w-BARE", Some(&store(&work.store_dir)));

    let status = t.claude_status().await;
    assert_eq!(
        serde_json::to_value(&status).expect("JSON"),
        json!({
            "id": "anthropic", "label": "Claude",
            "subscription": { "supported": true, "state": "signed_in", "source": "eos", "plan": "max" },
            "apiKey": { "set": true, "hint": "1234" },
            "route": "subscription",
            "logins": [
                { "id": personal.id, "label": "p@example.com", "email": "p@example.com", "plan": "max", "state": "signed_in" },
                { "id": work.id, "label": "Work", "email": "w@example.com", "plan": "max", "state": "signed_in", "inUse": 2 },
            ],
            "defaultLoginId": personal.id,
            "autoSwitch": true,
        }),
        "a sign-in bills the subscription even with a key set"
    );

    // A default whose store lost its sign-in hands new sessions on.
    t.stores.sign_in(&personal.store_dir, None, None);
    use eos_core::accounts::PlanStores as _;
    t.stores.sign_out(CLAUDE, &personal.store_dir).await.expect("signs out");
    let status = t.claude_status().await;
    assert_eq!(status.logins.expect("logins")[0].state, SubscriptionState::SignedOut);
    assert_eq!(status.route, BillingRoute::Subscription);
    assert_eq!(t.accounts.for_new_session(CLAUDE).await, Some(store(&work.store_dir)));

    // Presets: the key is the Keychain-backed profile that names it.
    let t = fixture(json!({ "backends": { "grok": {
        "kind": "openai", "model": "grok-4.3", "baseUrl": "https://api.x.ai", "auth": { "kind": "keychain", "ref": "eos-xai" },
    } } }));
    let list = t.accounts.status().list().await;
    assert_eq!(
        list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
        ["anthropic", "openai", "gemini", "xai", "qwen", "moonshot", "zhipu", "deepseek"]
    );
    assert_eq!(
        serde_json::to_value(&list[3]).expect("JSON"),
        json!({ "id": "xai", "label": "xAI Grok", "subscription": null, "apiKey": { "set": true }, "route": "api_key", "profile": "grok" })
    );
    assert_eq!(
        serde_json::to_value(&list[2]).expect("JSON"),
        json!({ "id": "gemini", "label": "Google Gemini", "subscription": { "supported": false, "state": "signed_out" }, "apiKey": { "set": false }, "route": "none" })
    );
}

// ---- usage per sign-in ----------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn usage_is_read_per_sign_in_with_its_own_token_and_chatgpt_reports_what_it_saw() {
    let t = fixture(json!({}));
    let signed_out = t.accounts.usage().get_usage().await;
    assert_eq!(
        serde_json::to_value(&signed_out).expect("JSON"),
        json!({ "providers": [], "errors": [
            { "provider": "claude", "reason": "No Claude subscription token configured." },
            { "provider": "codex", "reason": "Not signed in to ChatGPT." },
        ] }),
        "the recorded signed-out answer"
    );

    let me = t.login("me@example.com");
    t.accounts.logins().rename(CLAUDE, &me.id, "Personal").expect("renames");
    t.stores.sign_in("/acc/chatgpt", None, None);
    let chatgpt = SessionCredential::Store { provider: CHATGPT.into(), dir: "/acc/chatgpt".into() };
    let limits = PlanLimits {
        status: Some("allowed_warning".into()),
        claim: Some("seven_day".into()),
        resets_at_ms: Some(RESET),
        five_hour: Some(0.125),
        seven_day: Some(0.85),
    };
    t.accounts.observed(&chatgpt, &limits);
    t.clock.advance(MIN_INTERVAL_MS);
    let usage = t.accounts.usage().get_usage().await;
    assert_eq!(t.usage_api.tokens(), [format!("token-of:{}", me.store_dir)]);
    let claude = &usage.providers[0];
    assert_eq!(
        (claude.provider.as_str(), claude.login_id.as_deref(), claude.label.as_deref(), claude.plan.as_deref()),
        ("claude", Some(me.id.as_str()), Some("Personal"), Some("Max"))
    );
    assert_eq!(
        serde_json::to_value(&usage.providers[1]).expect("JSON"),
        json!({
            "provider": "codex",
            "windows": {
                "fiveHour": { "utilization": 12.5, "resetsAt": null },
                "sevenDay": { "utilization": 85, "resetsAt": "2026-11-11T16:40:00.000Z" },
            },
            "fetchedAt": "2026-11-11T12:00:00.000Z",
        })
    );
    assert_eq!(usage.errors, None);

    use eos_core::accounts::PlanAccess as _;
    assert_eq!(t.accounts.utilization(CLAUDE).await, Some(0.41));
    assert_eq!(t.accounts.access_token(CLAUDE, &me.id).await, Some(format!("token-of:{}", me.store_dir)));
    assert_eq!(t.accounts.access_token(CLAUDE, "nope").await, None);
}

/// A run that keeps off the network withholds every token: the old
/// setup-token in the configuration is no way round that.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_withholds_tokens_reads_no_usage_with_the_old_setup_token() {
    let t = fixture(json!({ "anthropic": { "authToken": "old-setup-token" } }));
    t.stores.withhold("not on this run");
    let usage = t.accounts.usage().get_usage().await;
    assert!(t.usage_api.tokens().is_empty(), "the usage endpoint was never asked");
    let errors = usage.errors.unwrap_or_default();
    assert_eq!(errors.first().map(|e| (e.provider.as_str(), e.reason.as_str())), Some(("claude", "not on this run")));

    // With no setup-token either, nobody is signed in: that is the reason.
    let t = fixture(json!({}));
    t.stores.withhold("not on this run");
    let errors = t.accounts.usage().get_usage().await.errors.unwrap_or_default();
    assert_eq!(errors.first().map(|e| e.reason.as_str()), Some(NO_CLAUDE_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sign_in_from_before_is_adopted_in_place() {
    let t = fixture(json!({}));
    t.accounts.adopt_existing().await.expect("nothing to adopt");
    assert!(t.accounts.logins().list(CLAUDE).is_empty());
    t.stores.sign_in("/acc/claude", Some("pro"), Some("old@example.com"));
    t.accounts.adopt_existing().await.expect("adopts");
    t.accounts.adopt_existing().await.expect("once");
    let logins = t.accounts.logins().list(CLAUDE);
    assert_eq!(logins.len(), 1);
    assert_eq!((logins[0].store_dir.as_str(), logins[0].label.as_str()), ("/acc/claude", "old@example.com"));
}
