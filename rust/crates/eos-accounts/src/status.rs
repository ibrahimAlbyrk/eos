//! The read side of Settings › Accounts: one redacted status per provider
//! (`manager/services/accounts/AccountsService.ts`). Claude comes first, with
//! every sign-in it holds, followed by every provider preset. Only sign-ins
//! made through Eos count. The route each account bills is the Accounts rule
//! of `eos-domain`, never recomputed here.

use std::sync::{Arc, Mutex};

use eos_contracts::{
    AccountStatus, AccountStatusApiKey, AccountSubscription, AccountSubscriptionSource, AuthRefKind, PlanLogin,
    SubscriptionState,
};
use eos_core::accounts::{TokenProbe, TokenProbeResult};
use eos_domain::accounts::{
    PROVIDER_PRESETS, PlanLimitReason, ProviderPreset, resolve_billing_route, sells_subscription,
};
use eos_domain::time::iso_from_ms;

use crate::plan::{CLAUDE, Plan};

const PROBE_TTL_MS: i64 = 10 * 60_000;

struct Probed {
    token: String,
    result: TokenProbeResult,
    at: i64,
}

pub struct AccountsService {
    plan: Arc<Plan>,
    probe: Arc<dyn TokenProbe>,
    /// The providers Eos can sign in to.
    sign_in: Vec<&'static str>,
    /// The last answer about a setup-token from before sign-ins had stores,
    /// so a revoked one shows as expired instead of failing inside a session.
    probed: Mutex<Option<Probed>>,
}

impl std::fmt::Debug for AccountsService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountsService").field("sign_in", &self.sign_in).finish_non_exhaustive()
    }
}

fn set(value: Option<&String>) -> Option<&str> {
    value.map(|v| v.trim()).filter(|v| !v.is_empty())
}

fn subscription(supported: bool, state: SubscriptionState, plan: Option<String>) -> AccountSubscription {
    let source = (state != SubscriptionState::SignedOut).then_some(AccountSubscriptionSource::Eos);
    AccountSubscription { supported, state, source, plan }
}

impl AccountsService {
    pub(crate) fn new(plan: Arc<Plan>, probe: Arc<dyn TokenProbe>, sign_in: Vec<&'static str>) -> Self {
        Self { plan, probe, sign_in, probed: Mutex::new(None) }
    }

    /// A credential changed: the next list checks the setup-token again.
    pub fn invalidate(&self) {
        *self.probed.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn supports_sign_in(&self, provider: &str) -> bool {
        self.sign_in.contains(&provider)
    }

    pub async fn list(&self) -> Vec<AccountStatus> {
        let mut accounts = vec![self.claude().await];
        for preset in PROVIDER_PRESETS {
            accounts.push(self.preset(preset).await);
        }
        accounts
    }

    async fn claude(&self) -> AccountStatus {
        let plan = &self.plan;
        let config = plan.config.current();
        let (token, api_key) = (set(config.anthropic.auth_token.as_ref()), set(config.anthropic.api_key.as_ref()));
        let supported = self.supports_sign_in(CLAUDE);

        let registry = plan.logins.registry();
        let reads = plan.reads(&registry, CLAUDE).await;
        let logins: Vec<PlanLogin> = registry
            .logins_of(CLAUDE)
            .map(|record| {
                let read = reads.get(&record.id).cloned().unwrap_or_default();
                let mark = plan.ledger.blocked(&record.id);
                let state = match mark {
                    Some(mark) if mark.reason == PlanLimitReason::Expired => SubscriptionState::Expired,
                    _ if read.present => SubscriptionState::SignedIn,
                    _ => SubscriptionState::SignedOut,
                };
                let limited_until =
                    mark.filter(|m| m.reason == PlanLimitReason::Limit).and_then(|m| m.until).map(iso_from_ms);
                let in_use = i64::try_from(plan.live.on_store(&record.store_dir)).unwrap_or(i64::MAX);
                PlanLogin {
                    id: record.id.clone(),
                    label: record.label.clone(),
                    email: record.email.clone(),
                    plan: read.plan,
                    state,
                    limited_until,
                    in_use: (in_use > 0).then_some(in_use),
                }
            })
            .collect();
        // The provider bills the sign-in new sessions start on; sign-ins that
        // all stopped working block rather than fall back to the key.
        let active = registry.runnable_login(CLAUDE, |l| plan.readiness(&reads, l));

        let subscription = if let Some(active) = active {
            subscription(supported, SubscriptionState::SignedIn, reads.get(&active.id).and_then(|r| r.plan.clone()))
        } else if !logins.is_empty() {
            subscription(supported, SubscriptionState::Expired, None)
        } else if let Some(token) = token {
            let rejected = self.probe_cached(token).await == TokenProbeResult::Rejected;
            let state = if rejected { SubscriptionState::Expired } else { SubscriptionState::SignedIn };
            subscription(supported, state, None)
        } else {
            subscription(supported, SubscriptionState::SignedOut, None)
        };

        AccountStatus {
            id: CLAUDE.to_owned(),
            label: "Claude".to_owned(),
            route: resolve_billing_route(subscription.state, api_key.is_some()),
            subscription: Some(subscription),
            api_key: AccountStatusApiKey {
                set: api_key.is_some(),
                // Never more of a key than its last four characters.
                hint: api_key.map(|k| k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()),
            },
            profile: None,
            logins: Some(logins),
            default_login_id: registry.default_login(CLAUDE).map(|l| l.id.clone()),
            auto_switch: Some(registry.auto_switch(CLAUDE)),
        }
    }

    async fn preset(&self, preset: &ProviderPreset) -> AccountStatus {
        let config = self.plan.config.current();
        let profile = config
            .backends
            .iter()
            .find(|(_, backend)| {
                backend.auth.as_ref().is_some_and(|auth| {
                    auth.kind == AuthRefKind::Keychain && auth.r#ref.as_deref() == Some(preset.auth_ref)
                })
            })
            .map(|(name, _)| name.clone());
        let subscription = if sells_subscription(preset.id) {
            let supported = self.supports_sign_in(preset.id);
            // A plan Eos has no lane for cannot bill anything: the key keeps the route.
            let login = if supported {
                let dir = self.plan.logins.single_store(preset.id);
                Some(self.plan.stores.read(preset.id, &dir).await).filter(|read| read.present)
            } else {
                None
            };
            Some(match login {
                Some(read) => subscription(supported, SubscriptionState::SignedIn, read.plan),
                None => subscription(supported, SubscriptionState::SignedOut, None),
            })
        } else {
            None
        };
        let state = subscription.as_ref().map_or(SubscriptionState::SignedOut, |s| s.state);
        AccountStatus {
            id: preset.id.to_owned(),
            label: preset.label.to_owned(),
            subscription,
            api_key: AccountStatusApiKey { set: profile.is_some(), hint: None },
            route: resolve_billing_route(state, profile.is_some()),
            profile,
            logins: None,
            default_login_id: None,
            auto_switch: None,
        }
    }

    async fn probe_cached(&self, token: &str) -> TokenProbeResult {
        let now = self.plan.clock.now_ms();
        {
            let probed = self.probed.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(p) = probed.as_ref().filter(|p| p.token == token && now - p.at < PROBE_TTL_MS) {
                return p.result;
            }
        }
        let result = self.probe.probe(token).await;
        // "Unknown" (offline, a server error) is not kept: the next list checks again.
        let keep = (result != TokenProbeResult::Unknown).then(|| Probed { token: token.to_owned(), result, at: now });
        *self.probed.lock().unwrap_or_else(|p| p.into_inner()) = keep;
        result
    }
}
