//! Fakes of the accounts ports (`eos_core::accounts`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use eos_contracts::{ProviderUsage, ProviderUsageWindows, UsageWindow};
use eos_core::accounts::{
    Browser, PlanLoginDirs, PlanLoginStore, PlanStores, PlanUsageApi, Secrets, SessionAccountSwitch, SessionCredential,
    SignInPages, SignInRequest, SignedIn, StoreLogin, SubscriptionProvider, TokenProbe, TokenProbeResult, UsageError,
    UsageProvider, UsageSnapshotStore,
};
use eos_core::os::LocalTime;
use eos_core::store::ConfigSource;
use eos_core::{BoxFuture, Error, Sleeper};
use eos_domain::accounts::PlanLoginRegistry;
use eos_domain::config::{Config, Env, Host, resolve};
use serde_json::{Map, Value};
use tokio::sync::oneshot;

fn locked<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().expect("a fake's state")
}

/// The sign-in registry in memory.
#[derive(Debug, Default)]
pub struct FakePlanLoginStore(Mutex<PlanLoginRegistry>);

impl FakePlanLoginStore {
    pub fn saved(&self) -> PlanLoginRegistry {
        locked(&self.0).clone()
    }
}

impl PlanLoginStore for FakePlanLoginStore {
    fn load(&self) -> PlanLoginRegistry {
        self.saved()
    }

    fn save(&self, registry: &PlanLoginRegistry) -> Result<(), Error> {
        *locked(&self.0) = registry.clone();
        Ok(())
    }
}

/// Store folders that exist only as names under `/acc`.
#[derive(Debug, Default)]
pub struct FakePlanLoginDirs {
    discarded: Mutex<Vec<String>>,
    trashed: Mutex<Vec<String>>,
}

fn cli(provider: &str) -> &str {
    match provider {
        "anthropic" => "claude",
        "openai" => "chatgpt",
        other => other,
    }
}

impl FakePlanLoginDirs {
    pub fn discarded(&self) -> Vec<String> {
        locked(&self.discarded).clone()
    }

    pub fn trashed(&self) -> Vec<String> {
        locked(&self.trashed).clone()
    }
}

impl PlanLoginDirs for FakePlanLoginDirs {
    fn create(&self, provider: &str, id: &str) -> Result<String, Error> {
        Ok(format!("/acc/{}-{id}", cli(provider)))
    }

    fn single(&self, provider: &str) -> String {
        format!("/acc/{}", cli(provider))
    }

    fn discard(&self, store_dir: &str) {
        locked(&self.discarded).push(store_dir.to_owned());
    }

    fn trash(&self, store_dir: &str) -> Result<(), Error> {
        locked(&self.trashed).push(store_dir.to_owned());
        Ok(())
    }
}

/// Credential stores in memory: a store holds a sign-in once
/// [`sign_in`](Self::sign_in) put one there.
#[derive(Debug, Default)]
pub struct FakePlanStores {
    stores: Mutex<HashMap<String, StoreLogin>>,
    signed_out: Mutex<Vec<String>>,
}

impl FakePlanStores {
    pub fn sign_in(&self, store_dir: &str, plan: Option<&str>, email: Option<&str>) {
        let login = StoreLogin {
            present: true,
            plan: plan.map(str::to_owned),
            email: email.map(str::to_owned),
            left_behind: false,
        };
        locked(&self.stores).insert(store_dir.to_owned(), login);
    }

    /// `store_dir` holds no sign-in, and the TypeScript app left one of its
    /// provider that this app cannot use.
    pub fn left_behind(&self, store_dir: &str) {
        locked(&self.stores).insert(store_dir.to_owned(), StoreLogin { left_behind: true, ..StoreLogin::default() });
    }

    /// The stores that were signed out, in order.
    pub fn signed_out(&self) -> Vec<String> {
        locked(&self.signed_out).clone()
    }
}

impl PlanStores for FakePlanStores {
    fn read<'a>(&'a self, _provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, StoreLogin> {
        let login = locked(&self.stores).get(store_dir).cloned().unwrap_or_default();
        Box::pin(async move { login })
    }

    /// `token-of:<store>` while the store is signed in.
    fn access_token<'a>(&'a self, _provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Option<String>> {
        let present = locked(&self.stores).get(store_dir).is_some_and(|l| l.present);
        Box::pin(async move { present.then(|| format!("token-of:{store_dir}")) })
    }

    /// A store's token never changes here: a renewal gives nothing new.
    fn refused<'a>(&'a self, _provider: &'a str, _store_dir: &'a str, _rejected: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }

    fn sign_out<'a>(&'a self, _provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        locked(&self.stores).remove(store_dir);
        locked(&self.signed_out).push(store_dir.to_owned());
        Box::pin(async { Ok(()) })
    }
}

/// Secrets in memory.
#[derive(Debug, Default)]
pub struct FakeSecrets(Mutex<HashMap<String, String>>);

impl Secrets for FakeSecrets {
    fn read(&self, service: &str) -> Option<String> {
        locked(&self.0).get(service).cloned()
    }

    fn write(&self, service: &str, secret: &str) -> Result<(), Error> {
        locked(&self.0).insert(service.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, service: &str) {
        locked(&self.0).remove(service);
    }
}

/// What one fake sign-in was started with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedSignIn {
    pub store_dir: String,
    pub login_hint: Option<String>,
}

/// A provider whose sign-in shows its pages at once and ends when the test
/// says so ([`finish`](Self::finish)).
pub struct FakeSubscriptionProvider {
    id: &'static str,
    multi_login: bool,
    accepts_code: bool,
    started: Mutex<Vec<StartedSignIn>>,
    waiting: Mutex<Vec<oneshot::Sender<Result<SignedIn, String>>>>,
    codes: Arc<Mutex<Vec<String>>>,
}

impl std::fmt::Debug for FakeSubscriptionProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeSubscriptionProvider").field("id", &self.id).finish_non_exhaustive()
    }
}

impl FakeSubscriptionProvider {
    /// Claude's shape: several sign-ins, a code may be pasted.
    pub fn several(id: &'static str) -> Arc<Self> {
        Self::new(id, true, true)
    }

    /// ChatGPT's shape: one sign-in, the browser comes back by itself.
    pub fn single(id: &'static str) -> Arc<Self> {
        Self::new(id, false, false)
    }

    fn new(id: &'static str, multi_login: bool, accepts_code: bool) -> Arc<Self> {
        Arc::new(Self {
            id,
            multi_login,
            accepts_code,
            started: Mutex::default(),
            waiting: Mutex::default(),
            codes: Arc::default(),
        })
    }

    pub fn started(&self) -> Vec<StartedSignIn> {
        locked(&self.started).clone()
    }

    /// The codes pasted into its sign-ins.
    pub fn codes(&self) -> Vec<String> {
        locked(&self.codes).clone()
    }

    /// How many of its sign-ins are still running.
    pub fn running(&self) -> usize {
        locked(&self.waiting).iter().filter(|tx| !tx.is_closed()).count()
    }

    /// Ends the sign-in started last; false when it is gone (cancelled).
    pub fn finish(&self, result: Result<SignedIn, String>) -> bool {
        locked(&self.waiting).pop().is_some_and(|tx| tx.send(result).is_ok())
    }
}

impl SubscriptionProvider for FakeSubscriptionProvider {
    fn id(&self) -> &'static str {
        self.id
    }

    fn accepts_code(&self) -> bool {
        self.accepts_code
    }

    fn multi_login(&self) -> bool {
        self.multi_login
    }

    fn sign_in(&self, request: SignInRequest) -> BoxFuture<'static, Result<SignedIn, String>> {
        let SignInRequest { store_dir, login_hint, on_pages, code } = request;
        locked(&self.started).push(StartedSignIn { store_dir, login_hint });
        let (tx, mut rx) = oneshot::channel();
        locked(&self.waiting).push(tx);
        let (codes, id) = (self.codes.clone(), self.id);
        Box::pin(async move {
            on_pages(SignInPages {
                open: format!("https://{id}.example/authorize?to=loopback"),
                shown: format!("https://{id}.example/authorize?to=code"),
            });
            tokio::select! {
                result = &mut rx => return result.unwrap_or_else(|_| Err("Sign-in cancelled.".to_owned())),
                pasted = code => {
                    if let Some(pasted) = pasted {
                        codes.lock().expect("codes").push(pasted);
                    }
                }
            }
            rx.await.unwrap_or_else(|_| Err("Sign-in cancelled.".to_owned()))
        })
    }
}

#[derive(Debug, Default)]
pub struct FakeBrowser(Mutex<Vec<String>>);

impl FakeBrowser {
    pub fn opened(&self) -> Vec<String> {
        locked(&self.0).clone()
    }
}

impl Browser for FakeBrowser {
    fn open(&self, url: &str) {
        locked(&self.0).push(url.to_owned());
    }
}

/// Answers every probe with the result set last (`Valid` at first).
#[derive(Debug)]
pub struct FakeTokenProbe {
    result: Mutex<TokenProbeResult>,
    calls: AtomicUsize,
}

impl Default for FakeTokenProbe {
    fn default() -> Self {
        Self { result: Mutex::new(TokenProbeResult::Valid), calls: AtomicUsize::new(0) }
    }
}

impl FakeTokenProbe {
    pub fn answer(&self, result: TokenProbeResult) {
        *locked(&self.result) = result;
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl TokenProbe for FakeTokenProbe {
    fn probe<'a>(&'a self, _token: &'a str) -> BoxFuture<'a, TokenProbeResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = *locked(&self.result);
        Box::pin(async move { result })
    }
}

fn usage_snapshot(provider: &str, login_id: Option<&str>) -> ProviderUsage {
    ProviderUsage {
        provider: provider.to_owned(),
        login_id: login_id.map(str::to_owned),
        label: None,
        plan: None,
        windows: ProviderUsageWindows {
            five_hour: Some(Some(UsageWindow {
                utilization: 41.0.into(),
                resets_at: Some("2030-01-01T00:00:00.000Z".into()),
                severity: None,
            })),
            seven_day: Some(None),
            weekly_by_model: None,
        },
        extra_usage: None,
        fetched_at: "2026-01-01T09:30:00.125Z".into(),
        stale: None,
    }
}

/// The usage endpoint: answers with a fixed snapshot, or what the test set.
#[derive(Debug, Default)]
pub struct FakePlanUsageApi {
    answer: Mutex<Option<Result<ProviderUsage, String>>>,
    by_token: Mutex<HashMap<String, Result<ProviderUsage, String>>>,
    tokens: Mutex<Vec<String>>,
}

impl FakePlanUsageApi {
    pub fn answer(&self, answer: Result<ProviderUsage, String>) {
        *locked(&self.answer) = Some(answer);
    }

    /// What a read with `token` answers, whatever the others get.
    pub fn answer_for(&self, token: &str, answer: Result<ProviderUsage, String>) {
        locked(&self.by_token).insert(token.to_owned(), answer);
    }

    /// The tokens it was read with, in order.
    pub fn tokens(&self) -> Vec<String> {
        locked(&self.tokens).clone()
    }
}

impl PlanUsageApi for FakePlanUsageApi {
    fn fetch<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<ProviderUsage, String>> {
        locked(&self.tokens).push(token.to_owned());
        let one = locked(&self.by_token).get(token).cloned();
        let answer = one.or_else(|| locked(&self.answer).clone()).unwrap_or_else(|| Ok(usage_snapshot("claude", None)));
        Box::pin(async move { answer })
    }
}

/// One plan's usage source: a fixed snapshot until the test sets an answer.
#[derive(Debug)]
pub struct FakeUsageProvider {
    id: String,
    answer: Mutex<Result<ProviderUsage, UsageError>>,
    calls: AtomicUsize,
}

impl FakeUsageProvider {
    /// `id`: `claude`, or `claude:<login id>`.
    pub fn new(id: &str) -> Arc<Self> {
        let (provider, login) = id.split_once(':').map_or((id, None), |(p, l)| (p, Some(l)));
        Arc::new(Self {
            id: id.to_owned(),
            answer: Mutex::new(Ok(usage_snapshot(provider, login))),
            calls: AtomicUsize::new(0),
        })
    }

    pub fn snapshot(provider: &str, login_id: Option<&str>) -> ProviderUsage {
        usage_snapshot(provider, login_id)
    }

    pub fn answer(&self, answer: Result<ProviderUsage, UsageError>) {
        *locked(&self.answer) = answer;
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl UsageProvider for FakeUsageProvider {
    fn id(&self) -> String {
        self.id.clone()
    }

    fn fetch(&self) -> BoxFuture<'_, Result<ProviderUsage, UsageError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let answer = locked(&self.answer).clone();
        Box::pin(async move { answer })
    }
}

#[derive(Debug, Default)]
pub struct FakeUsageSnapshots(Mutex<Vec<ProviderUsage>>);

impl FakeUsageSnapshots {
    pub fn with(saved: Vec<ProviderUsage>) -> Self {
        Self(Mutex::new(saved))
    }

    pub fn saved(&self) -> Vec<ProviderUsage> {
        locked(&self.0).clone()
    }
}

impl UsageSnapshotStore for FakeUsageSnapshots {
    fn load(&self) -> Vec<ProviderUsage> {
        self.saved()
    }

    fn save(&self, snapshots: &[ProviderUsage]) -> Result<(), Error> {
        *locked(&self.0) = snapshots.to_vec();
        Ok(())
    }
}

/// The time of day in UTC, so a test reads the same everywhere.
#[derive(Debug, Default, Clone, Copy)]
pub struct FakeLocalTime;

impl LocalTime for FakeLocalTime {
    fn hour_minute(&self, epoch_ms: i64) -> String {
        eos_domain::time::iso_from_ms(epoch_ms)[11..16].to_owned()
    }
}

/// The engine's side of an account switch: records each move.
#[derive(Debug, Default)]
pub struct FakeSessionSwitch {
    moves: Mutex<Vec<(String, SessionCredential)>>,
    refusal: Mutex<Option<String>>,
}

impl FakeSessionSwitch {
    pub fn moves(&self) -> Vec<(String, SessionCredential)> {
        locked(&self.moves).clone()
    }

    /// Every later move fails with `reason`.
    pub fn refuse(&self, reason: &str) {
        *locked(&self.refusal) = Some(reason.to_owned());
    }
}

impl SessionAccountSwitch for FakeSessionSwitch {
    fn move_session<'a>(
        &'a self,
        worker_id: &'a str,
        credential: SessionCredential,
    ) -> BoxFuture<'a, Result<(), String>> {
        let refusal = locked(&self.refusal).clone();
        if refusal.is_none() {
            locked(&self.moves).push((worker_id.to_owned(), credential));
        }
        Box::pin(async move { refusal.map_or(Ok(()), Err) })
    }
}

/// The configuration a `config.json` with this content gives, changed in
/// memory by [`ConfigSource::patch`].
#[derive(Debug)]
pub struct FakeConfig {
    file: Mutex<Value>,
    current: Mutex<Arc<Config>>,
}

fn resolved(file: &Value) -> Arc<Config> {
    let host = Host { home: "/home/.eos".to_owned(), env: Env::new(std::iter::empty()), remote_feature: false };
    Arc::new(resolve(&host, Some(file.clone())).0)
}

impl FakeConfig {
    pub fn new(file: Value) -> Self {
        let current = Mutex::new(resolved(&file));
        Self { file: Mutex::new(file), current }
    }

    /// The file's content now.
    pub fn file(&self) -> Value {
        locked(&self.file).clone()
    }
}

impl Default for FakeConfig {
    fn default() -> Self {
        Self::new(Value::Object(Map::new()))
    }
}

impl ConfigSource for FakeConfig {
    fn current(&self) -> Arc<Config> {
        locked(&self.current).clone()
    }

    fn declared_backends(&self) -> Option<Vec<String>> {
        let file = locked(&self.file);
        let names: Vec<String> = file.get("backends")?.as_object()?.keys().cloned().collect();
        (!names.is_empty()).then_some(names)
    }

    fn reload(&self) -> Arc<Config> {
        self.current()
    }

    fn patch(&self, section: &str, patch: Map<String, Value>) -> Result<Arc<Config>, Error> {
        let mut file = locked(&self.file);
        let root = file.as_object_mut().ok_or_else(|| Error::Storage("config.json is not an object".into()))?;
        let block = root.entry(section).or_insert_with(|| Value::Object(Map::new()));
        if let Some(block) = block.as_object_mut() {
            for (key, value) in patch {
                if value.is_null() {
                    block.shift_remove(&key);
                } else {
                    block.insert(key, value);
                }
            }
        }
        let config = resolved(&file);
        *locked(&self.current) = config.clone();
        Ok(config)
    }
}

/// Waits that end when the test says so.
#[derive(Debug, Default)]
pub struct FakeSleeper {
    waiting: Mutex<Vec<(i64, oneshot::Sender<()>)>>,
}

impl FakeSleeper {
    /// How long each wait still pending was asked to be, oldest first. A wait
    /// whose task was cancelled is not listed.
    pub fn pending(&self) -> Vec<i64> {
        let mut waiting = locked(&self.waiting);
        waiting.retain(|(_, tx)| !tx.is_closed());
        waiting.iter().map(|(ms, _)| *ms).collect()
    }

    /// Ends the oldest pending wait; false when there is none.
    pub fn wake(&self) -> bool {
        let mut waiting = locked(&self.waiting);
        waiting.retain(|(_, tx)| !tx.is_closed());
        if waiting.is_empty() {
            return false;
        }
        waiting.remove(0).1.send(()).is_ok()
    }
}

impl Sleeper for FakeSleeper {
    fn sleep(&self, ms: i64) -> BoxFuture<'static, ()> {
        let (tx, rx) = oneshot::channel();
        locked(&self.waiting).push((ms, tx));
        Box::pin(async move {
            let _ = rx.await;
        })
    }
}

/// The system's secret store, empty: every read finds nothing and a write is
/// refused, so a Claude sign-in is read from its store's plaintext
/// `.credentials.json` and nothing reaches the real keychain.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoKeychain;

impl eos_platform::CredentialStore for NoKeychain {
    fn read_claude_store(&self, _store_dir: Option<&std::path::Path>) -> Option<String> {
        None
    }

    fn write_claude_store(&self, _store_dir: &std::path::Path, _json: &str) -> Result<(), eos_platform::Error> {
        Err(eos_platform::Error::Unsupported("secret storage"))
    }

    fn clear_claude_store(&self, _store_dir: &std::path::Path) {}

    fn read_secret(&self, _service: &str) -> Option<String> {
        None
    }

    fn write_secret(&self, _service: &str, _secret: &str) -> Result<(), eos_platform::Error> {
        Err(eos_platform::Error::Unsupported("secret storage"))
    }

    fn delete_secret(&self, _service: &str) {}
}
