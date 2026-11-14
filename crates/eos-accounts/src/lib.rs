//! Accounts (Settings › Accounts, Settings › Usage): every sign-in Eos made,
//! the credential a new session starts on, what happens when one runs out
//! mid-turn, sign-ins in flight and plan usage, built in one place.
//!
//! Only sign-ins made through Eos count: each lives in a credential store
//! under `<home>/accounts`. A Claude Code or ChatGPT sign-in elsewhere on the
//! computer is ignored for status, billing and usage.
//!
//! Everything here works over the ports of `eos-core::accounts`; the stores,
//! the providers' sign-in flows and the usage endpoint are `eos-auth`'s.

mod ledger;
mod logins;
mod plan;
mod resume;
mod sign_in;
mod status;
mod usage;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use eos_contracts::{ProviderUsage, ProviderUsageWindows, UsageWindow};
use eos_core::accounts::{
    Browser, PlanAccess, PlanFailure, PlanLimits, PlanLoginDirs, PlanLoginStore, PlanStores, PlanUsageApi, PlanVerdict,
    SessionAccountSwitch, SessionCredential, SessionCredentials, SubscriptionProvider, TokenProbe, UsageError,
    UsageProvider, UsageSnapshotStore, usage_key,
};
use eos_core::os::LocalTime;
use eos_core::store::{Announcer, ConfigSource, Store};
use eos_core::{BoxFuture, Clock, Error, Ids, Sleeper};
use eos_domain::accounts::PlanLoginRecord;
use eos_domain::time::iso_from_ms;

pub use ledger::PlanLimitLedger;
pub use logins::{Committed, PlanLoginService, SignInTarget};
pub use plan::{CHATGPT, CLAUDE};
pub use resume::PlanResumeService;
pub use sign_in::SignInService;
pub use status::AccountsService;
pub use usage::{MIN_INTERVAL_MS, Providers, UsageService};

use plan::{LiveSessions, Plan};
use sign_in::SignInDeps;

/// Why there is no usage to show for Claude. The dashboard matches on the
/// "subscription token" phrase and shows a quiet hint instead of an error.
pub const NO_CLAUDE_TOKEN: &str = "No Claude subscription token configured.";
pub const CHATGPT_NOT_SIGNED_IN: &str = "Not signed in to ChatGPT.";
/// The id ChatGPT's plan usage is served under, as the dashboard knows it.
const CHATGPT_USAGE: &str = "codex";

/// What the accounts are built from: ports only.
pub struct Deps {
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub config: Arc<dyn ConfigSource>,
    pub store: Arc<dyn Store>,
    pub announcer: Arc<dyn Announcer>,
    pub login_store: Arc<dyn PlanLoginStore>,
    pub dirs: Arc<dyn PlanLoginDirs>,
    pub stores: Arc<dyn PlanStores>,
    /// The providers a user can sign in to.
    pub providers: Vec<Arc<dyn SubscriptionProvider>>,
    pub browser: Arc<dyn Browser>,
    pub probe: Arc<dyn TokenProbe>,
    pub usage_api: Arc<dyn PlanUsageApi>,
    pub usage_cache: Arc<dyn UsageSnapshotStore>,
    pub local_time: Arc<dyn LocalTime>,
    pub sleeper: Arc<dyn Sleeper>,
    pub sessions: Arc<dyn SessionAccountSwitch>,
}

impl std::fmt::Debug for Deps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Deps").finish_non_exhaustive()
    }
}

/// Waits on the app's timer.
#[derive(Debug, Default, Clone, Copy)]
pub struct TokioSleeper;

impl Sleeper for TokioSleeper {
    fn sleep(&self, ms: i64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms.max(0).unsigned_abs())))
    }
}

/// The accounts of this install.
pub struct Accounts {
    plan: Arc<Plan>,
    status: Arc<AccountsService>,
    sign_ins: Arc<SignInService>,
    resume: Arc<PlanResumeService>,
}

impl std::fmt::Debug for Accounts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Accounts").finish_non_exhaustive()
    }
}

fn plan_title(plan: Option<&str>) -> Option<String> {
    let mut chars = plan?.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().chain(chars).collect())
}

/// One Claude sign-in's usage: its token from its own store, renewed there.
struct ClaudeUsage {
    login: PlanLoginRecord,
    logins: Arc<PlanLoginService>,
    stores: Arc<dyn PlanStores>,
    api: Arc<dyn PlanUsageApi>,
}

impl UsageProvider for ClaudeUsage {
    fn id(&self) -> String {
        usage_key("claude", Some(&self.login.id))
    }

    fn fetch(&self) -> BoxFuture<'_, Result<ProviderUsage, UsageError>> {
        Box::pin(async move {
            let dir = &self.login.store_dir;
            let token = self.stores.access_token(CLAUDE, dir).await;
            let token = token.ok_or_else(|| match self.stores.withheld() {
                // The sign-in is there: its last snapshot stays, marked stale.
                Some(why) => UsageError::Failed(why.to_owned()),
                None => UsageError::NoAccount(NO_CLAUDE_TOKEN.to_owned()),
            })?;
            let snapshot = self.api.fetch(&token).await.map_err(UsageError::Failed)?;
            // The label of the moment: the user may have renamed the sign-in.
            let label = self.logins.registry().find(CLAUDE, &self.login.id).map(|l| l.label.clone());
            Ok(ProviderUsage {
                login_id: Some(self.login.id.clone()),
                label: Some(label.unwrap_or_else(|| self.login.label.clone())),
                plan: plan_title(self.stores.read(CLAUDE, dir).await.plan.as_deref()),
                ..snapshot
            })
        })
    }
}

/// With no sign-in, the setup-token of an older install is all there is; the
/// endpoint refuses it for scope, which the dashboard turns into "sign in again".
struct LegacyClaudeUsage {
    config: Arc<dyn ConfigSource>,
    /// Asked only whether this run withholds tokens: the setup-token is the
    /// configuration's, not a store's.
    stores: Arc<dyn PlanStores>,
    api: Arc<dyn PlanUsageApi>,
}

impl UsageProvider for LegacyClaudeUsage {
    fn id(&self) -> String {
        usage_key("claude", None)
    }

    fn fetch(&self) -> BoxFuture<'_, Result<ProviderUsage, UsageError>> {
        Box::pin(async move {
            let token = self.config.current().anthropic.auth_token.clone();
            let token = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
            let token = token.ok_or_else(|| UsageError::NoAccount(NO_CLAUDE_TOKEN.to_owned()))?;
            if let Some(why) = self.stores.withheld() {
                return Err(UsageError::Failed(why.to_owned()));
            }
            self.api.fetch(&token).await.map_err(UsageError::Failed)
        })
    }
}

/// ChatGPT's plan limits, as its latest response reported them.
struct ChatGptUsage {
    plan: std::sync::Weak<Plan>,
}

fn window(used: Option<f64>, resets_at: Option<i64>) -> Option<Option<UsageWindow>> {
    Some(used.map(|share| UsageWindow {
        utilization: (share * 100.0).clamp(0.0, 100.0).into(),
        resets_at: resets_at.map(iso_from_ms),
        severity: None,
    }))
}

impl UsageProvider for ChatGptUsage {
    fn id(&self) -> String {
        CHATGPT_USAGE.to_owned()
    }

    fn fetch(&self) -> BoxFuture<'_, Result<ProviderUsage, UsageError>> {
        Box::pin(async move {
            let signed_out = || UsageError::NoAccount(CHATGPT_NOT_SIGNED_IN.to_owned());
            let plan = self.plan.upgrade().ok_or_else(signed_out)?;
            let dir = plan.logins.single_store(CHATGPT);
            let read = plan.stores.read(CHATGPT, &dir).await;
            if !read.present {
                return Err(signed_out());
            }
            let seen = plan.chatgpt_limits.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let (limits, at) = seen.unwrap_or_else(|| (PlanLimits::default(), plan.clock.now_ms()));
            // The reset time belongs to the window that binds.
            let resets = |name: &str| limits.resets_at_ms.filter(|_| limits.claim.as_deref() == Some(name));
            Ok(ProviderUsage {
                provider: CHATGPT_USAGE.to_owned(),
                login_id: None,
                label: None,
                plan: plan_title(read.plan.as_deref()),
                windows: ProviderUsageWindows {
                    five_hour: window(limits.five_hour, resets("five_hour")),
                    seven_day: window(limits.seven_day, resets("seven_day")),
                    weekly_by_model: None,
                },
                extra_usage: None,
                fetched_at: iso_from_ms(at),
                stale: None,
            })
        })
    }
}

impl Accounts {
    pub fn new(deps: Deps) -> Arc<Self> {
        let logins = Arc::new(PlanLoginService::new(deps.login_store, deps.dirs, deps.clock.clone(), deps.ids.clone()));
        let ledger = Arc::new(PlanLimitLedger::new(deps.clock.clone()));

        // One usage provider per Claude sign-in, kept while the sign-in is
        // listed; then ChatGPT's.
        let (stores, api, config) = (deps.stores.clone(), deps.usage_api, deps.config.clone());
        let legacy: Arc<dyn UsageProvider> =
            Arc::new(LegacyClaudeUsage { config: config.clone(), stores: stores.clone(), api: api.clone() });
        let per_login: Mutex<HashMap<String, Arc<dyn UsageProvider>>> = Mutex::default();
        let listed = logins.clone();
        let chatgpt_slot: Arc<Mutex<Option<Arc<dyn UsageProvider>>>> = Arc::default();
        let chatgpt = chatgpt_slot.clone();
        let providers: Providers = Arc::new(move || {
            let current = listed.list(CLAUDE);
            let mut kept = per_login.lock().unwrap_or_else(|p| p.into_inner());
            kept.retain(|id, _| current.iter().any(|l| l.id == *id));
            let mut list: Vec<Arc<dyn UsageProvider>> = current
                .into_iter()
                .map(|login| {
                    let id = login.id.clone();
                    let provider = kept.entry(id).or_insert_with(|| {
                        Arc::new(ClaudeUsage {
                            login,
                            logins: listed.clone(),
                            stores: stores.clone(),
                            api: api.clone(),
                        })
                    });
                    provider.clone()
                })
                .collect();
            if list.is_empty() {
                list.push(legacy.clone());
            }
            list.extend(chatgpt.lock().unwrap_or_else(|p| p.into_inner()).clone());
            list
        });
        let usage = Arc::new(UsageService::new(providers, deps.clock.clone(), deps.usage_cache, deps.announcer));

        let plan = Arc::new(Plan {
            clock: deps.clock,
            config,
            store: deps.store,
            logins: logins.clone(),
            ledger: ledger.clone(),
            stores: deps.stores.clone(),
            usage: usage.clone(),
            sessions: Mutex::new(deps.sessions),
            local_time: deps.local_time,
            sleeper: deps.sleeper,
            live: LiveSessions::default(),
            chatgpt_limits: Mutex::new(None),
        });
        *chatgpt_slot.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Arc::new(ChatGptUsage { plan: Arc::downgrade(&plan) }));

        let status =
            Arc::new(AccountsService::new(plan.clone(), deps.probe, SignInService::provider_ids(&deps.providers)));
        let sign_ins = Arc::new(SignInService::new(SignInDeps {
            providers: deps.providers,
            ids: deps.ids,
            logins,
            ledger,
            stores: deps.stores,
            config: plan.config.clone(),
            browser: deps.browser,
            usage,
            status: status.clone(),
        }));
        let resume = Arc::new(PlanResumeService::new(plan.clone()));
        Arc::new(Self { plan, status, sign_ins, resume })
    }

    /// Claude's sign-in from before it could hold several (`accounts/claude`)
    /// becomes its first one, in place. Run once at start-up.
    pub async fn adopt_existing(&self) -> Result<(), Error> {
        let dir = self.plan.logins.single_store(CLAUDE);
        if !self.plan.logins.list(CLAUDE).is_empty() {
            return Ok(());
        }
        let read = self.plan.stores.read(CLAUDE, &dir).await;
        if read.present {
            self.plan.logins.adopt(CLAUDE, &dir, read.email.as_deref())?;
        }
        Ok(())
    }

    /// Hands over the engine's side of an account move. The engine is built
    /// after the accounts (it asks them for credentials), so it arrives here.
    pub fn attach_sessions(&self, sessions: Arc<dyn SessionAccountSwitch>) {
        *self.plan.sessions.lock().unwrap_or_else(|p| p.into_inner()) = sessions;
    }

    /// The one write path of the sign-in registry.
    pub fn logins(&self) -> &Arc<PlanLoginService> {
        &self.plan.logins
    }

    pub fn ledger(&self) -> &Arc<PlanLimitLedger> {
        &self.plan.ledger
    }

    pub fn status(&self) -> &Arc<AccountsService> {
        &self.status
    }

    pub fn sign_ins(&self) -> &Arc<SignInService> {
        &self.sign_ins
    }

    pub fn usage(&self) -> &Arc<UsageService> {
        &self.plan.usage
    }

    pub fn resume(&self) -> &Arc<PlanResumeService> {
        &self.resume
    }

    /// "Use API key" on an `accounts_exhausted` row: this session goes on
    /// billing per token. `Err` reads as the dashboard shows it.
    pub async fn continue_on_api_key(&self, worker_id: &str) -> Result<(), String> {
        self.plan.continue_on_api_key(worker_id, CLAUDE).await
    }
}

impl SessionCredentials for Accounts {
    fn for_new_session<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Option<SessionCredential>> {
        Box::pin(self.plan.for_new_session(provider))
    }

    fn launched(&self, worker_id: &str, credential: Option<&SessionCredential>) {
        self.plan.live.set(worker_id, credential);
    }

    fn observed(&self, credential: &SessionCredential, limits: &PlanLimits) {
        if matches!(credential, SessionCredential::Store { provider, .. } if provider == CHATGPT) {
            let seen = (limits.clone(), self.plan.clock.now_ms());
            *self.plan.chatgpt_limits.lock().unwrap_or_else(|p| p.into_inner()) = Some(seen);
        }
    }

    fn failed<'a>(&'a self, worker_id: &'a str, failure: &'a PlanFailure) -> BoxFuture<'a, PlanVerdict> {
        Box::pin(self.plan.failed(worker_id, failure))
    }
}

impl PlanAccess for Accounts {
    fn logins(&self, provider: &str) -> Vec<PlanLoginRecord> {
        self.plan.logins.list(provider)
    }

    fn access_token<'a>(&'a self, provider: &'a str, login_id: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let login = self.plan.logins.registry().find(provider, login_id).cloned()?;
            self.plan.stores.access_token(provider, &login.store_dir).await
        })
    }

    fn token_refused<'a>(&'a self, provider: &'a str, login_id: &'a str, rejected: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let Some(login) = self.plan.logins.registry().find(provider, login_id).cloned() else { return false };
            self.plan.stores.refused(provider, &login.store_dir, rejected).await
        })
    }

    fn login_of_worker(&self, provider: &str, worker_id: &str) -> Option<String> {
        let Some(SessionCredential::Store { provider: on, dir }) = self.plan.live.get(worker_id) else { return None };
        if on != provider {
            return None;
        }
        self.plan.logins.list(provider).into_iter().find(|l| std::path::Path::new(&l.store_dir) == dir).map(|l| l.id)
    }

    fn utilization<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Option<f64>> {
        Box::pin(async move {
            let Some(SessionCredential::Store { dir, .. }) = self.plan.for_new_session(provider).await else {
                return None;
            };
            let login =
                self.plan.logins.list(provider).into_iter().find(|l| std::path::Path::new(&l.store_dir) == dir)?;
            let usage = self.plan.usage.get_usage().await;
            let snapshot = usage.providers.iter().find(|p| p.login_id.as_deref() == Some(login.id.as_str()))?;
            let spent = [&snapshot.windows.five_hour, &snapshot.windows.seven_day]
                .into_iter()
                .filter_map(|w| w.clone().flatten())
                .map(|w| w.utilization.as_f64())
                .fold(None, |most: Option<f64>, used| Some(most.map_or(used, |m| m.max(used))));
            spent.map(|percent| percent / 100.0)
        })
    }

    fn withheld(&self) -> Option<&'static str> {
        self.plan.stores.withheld()
    }
}

#[cfg(test)]
mod tests;
