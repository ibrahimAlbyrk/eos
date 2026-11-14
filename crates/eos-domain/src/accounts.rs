//! Accounts: which credential a provider's sessions bill, the plan sign-ins a
//! provider holds, and which of them can run right now.

use eos_contracts::{BillingRoute, SubscriptionState};
use indexmap::IndexMap;

/// The Accounts rule. Signed in: the subscription, always; the API key is
/// never used beside it. An expired sign-in blocks instead of quietly falling
/// back to the metered key: the user expected their plan to pay. Signed out:
/// the API key, when one is set.
pub fn resolve_billing_route(subscription: SubscriptionState, api_key_set: bool) -> BillingRoute {
    match subscription {
        SubscriptionState::SignedIn => BillingRoute::Subscription,
        SubscriptionState::Expired => BillingRoute::Blocked,
        SubscriptionState::SignedOut if api_key_set => BillingRoute::ApiKey,
        SubscriptionState::SignedOut => BillingRoute::None,
    }
}

/// A provider Eos ships ready to add: what the Accounts list needs of it.
/// The connection details of the metered presets are not ported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    /// The Keychain service its API key is saved under.
    pub auth_ref: &'static str,
}

/// The metered provider presets, in the order Settings lists them.
pub const PROVIDER_PRESETS: &[ProviderPreset] = &[
    ProviderPreset { id: "openai", label: "OpenAI", auth_ref: "eos-openai" },
    ProviderPreset { id: "gemini", label: "Google Gemini", auth_ref: "eos-gemini" },
    ProviderPreset { id: "xai", label: "xAI Grok", auth_ref: "eos-xai" },
    ProviderPreset { id: "qwen", label: "Alibaba Qwen", auth_ref: "eos-qwen" },
    ProviderPreset { id: "moonshot", label: "Moonshot Kimi", auth_ref: "eos-moonshot" },
    ProviderPreset { id: "zhipu", label: "Zhipu GLM (Z.ai)", auth_ref: "eos-zhipu" },
    ProviderPreset { id: "deepseek", label: "DeepSeek", auth_ref: "eos-deepseek" },
];

/// Providers that sell a subscription; the rest are API-key-only.
pub fn sells_subscription(provider: &str) -> bool {
    matches!(provider, "anthropic" | "openai" | "gemini")
}

/// One plan sign-in: where its credential is stored, never the credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanLoginRecord {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub email: Option<String>,
    /// The sign-in's credential store folder.
    pub store_dir: String,
    /// ISO time.
    pub created_at: String,
}

/// The non-secret index of every plan sign-in plus, per provider, the one new
/// sessions start on. Every change returns a new registry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanLoginRegistry {
    /// In the order they were added.
    pub logins: Vec<PlanLoginRecord>,
    /// provider → default login id.
    pub defaults: IndexMap<String, String>,
    /// provider → move a session to another login when its own runs out (on unless set).
    pub auto_switch: IndexMap<String, bool>,
}

/// What a sign-in is called until the user names it: its email, else its place.
pub fn default_login_label(email: Option<&str>, existing: usize) -> String {
    match email.map(str::trim).filter(|e| !e.is_empty()) {
        Some(email) => email.to_owned(),
        None => format!("Account {}", existing + 1),
    }
}

impl PlanLoginRegistry {
    pub fn logins_of<'a>(&'a self, provider: &'a str) -> impl Iterator<Item = &'a PlanLoginRecord> {
        self.logins.iter().filter(move |l| l.provider == provider)
    }

    pub fn find(&self, provider: &str, id: &str) -> Option<&PlanLoginRecord> {
        self.logins.iter().find(|l| l.id == id && l.provider == provider)
    }

    /// The registry's default, else the oldest: a provider with logins always has one.
    pub fn default_login<'a>(&'a self, provider: &'a str) -> Option<&'a PlanLoginRecord> {
        let wanted = self.defaults.get(provider);
        self.logins_of(provider).find(|l| Some(&l.id) == wanted).or_else(|| self.logins_of(provider).next())
    }

    /// The login a new session starts on: the default while it can run, else
    /// the oldest one that can.
    pub fn session_login<'a>(
        &'a self,
        provider: &'a str,
        usable: impl Fn(&PlanLoginRecord) -> bool,
    ) -> Option<&'a PlanLoginRecord> {
        let preferred = self.default_login(provider);
        if let Some(login) = preferred.filter(|l| usable(l)) {
            return Some(login);
        }
        self.logins_of(provider).find(|l| Some(l.id.as_str()) != preferred.map(|p| p.id.as_str()) && usable(l))
    }

    /// The login new sessions run on: a ready one, picked as
    /// [`session_login`](Self::session_login) picks; when every login is at
    /// its limit, one of those (its turn then meets the limit like any
    /// other). `None`: none is signed in.
    pub fn runnable_login<'a>(
        &'a self,
        provider: &'a str,
        readiness: impl Fn(&PlanLoginRecord) -> LoginReadiness,
    ) -> Option<&'a PlanLoginRecord> {
        self.session_login(provider, |l| readiness(l) == LoginReadiness::Ready)
            .or_else(|| self.session_login(provider, |l| readiness(l) == LoginReadiness::Limited))
    }

    /// The login a session moves to when its own runs out: of the usable
    /// ones, the one with the most room left (lowest use, unknown counting as
    /// none); ties go to the default, then the oldest.
    pub fn switch_target<'a>(
        &'a self,
        provider: &'a str,
        usable: impl Fn(&PlanLoginRecord) -> bool,
        used: impl Fn(&PlanLoginRecord) -> Option<f64>,
    ) -> Option<&'a PlanLoginRecord> {
        let preferred = self.default_login(provider).map(|l| l.id.as_str());
        let mut best: Option<(&PlanLoginRecord, f64)> = None;
        for login in self.logins_of(provider).filter(|l| usable(l)) {
            let use_ = used(login).unwrap_or(0.0);
            let better = match best {
                None => true,
                Some((_, least)) if use_ < least => true,
                // Earlier logins win a tie, except against the default.
                Some((_, least)) => use_ == least && preferred == Some(login.id.as_str()),
            };
            if better {
                best = Some((login, use_));
            }
        }
        best.map(|(login, _)| login)
    }

    pub fn find_by_email<'a>(&'a self, provider: &'a str, email: &str) -> Option<&'a PlanLoginRecord> {
        let key = email.trim().to_lowercase();
        self.logins_of(provider).find(|l| l.email.as_ref().is_some_and(|e| e.to_lowercase() == key))
    }

    pub fn auto_switch(&self, provider: &str) -> bool {
        self.auto_switch.get(provider).copied().unwrap_or(true)
    }

    /// A provider's first login becomes its default.
    pub fn with_login(mut self, login: PlanLoginRecord) -> Self {
        if self.logins_of(&login.provider).next().is_none() {
            self.defaults.insert(login.provider.clone(), login.id.clone());
        }
        self.logins.push(login);
        self
    }

    /// Removing the default hands it to the oldest login left.
    pub fn without_login(mut self, id: &str) -> Self {
        let Some(at) = self.logins.iter().position(|l| l.id == id) else { return self };
        let gone = self.logins.remove(at);
        if self.defaults.get(&gone.provider).is_some_and(|d| d == id) {
            self.defaults.shift_remove(&gone.provider);
            let next = self.logins_of(&gone.provider).next().map(|next| next.id.clone());
            if let Some(next) = next {
                self.defaults.insert(gone.provider, next);
            }
        }
        self
    }

    pub fn with_login_changed(mut self, id: &str, change: impl FnOnce(&mut PlanLoginRecord)) -> Self {
        if let Some(login) = self.logins.iter_mut().find(|l| l.id == id) {
            change(login);
        }
        self
    }

    pub fn with_default_login(mut self, provider: &str, id: &str) -> Self {
        self.defaults.insert(provider.to_owned(), id.to_owned());
        self
    }

    pub fn with_auto_switch(mut self, provider: &str, enabled: bool) -> Self {
        self.auto_switch.insert(provider.to_owned(), enabled);
        self
    }
}

/// Why a sign-in was set aside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanLimitReason {
    /// At its plan limit; lifts by itself.
    Limit,
    /// Stopped working; out until it is signed in again.
    Expired,
}

impl PlanLimitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanLimitReason::Limit => "limit",
            PlanLimitReason::Expired => "expired",
        }
    }
}

/// Whether a sign-in can run. `Limited`: at its plan limit, still signed in.
/// `Out`: cannot run until it is signed in again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginReadiness {
    Ready,
    Limited,
    Out,
}

/// A limit reported without its reset time is retried after this long.
pub const LIMIT_WITHOUT_RESET_MS: i64 = 60 * 60_000;

/// One sign-in set aside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimitMark {
    pub reason: PlanLimitReason,
    /// When a limit lifts (epoch ms); `None` for a sign-in that stopped working.
    pub until: Option<i64>,
}

impl PlanLimitMark {
    pub fn new(reason: PlanLimitReason, until: Option<i64>, now: i64) -> Self {
        match reason {
            PlanLimitReason::Limit => Self { reason, until: Some(until.unwrap_or(now + LIMIT_WITHOUT_RESET_MS)) },
            PlanLimitReason::Expired => Self { reason, until: None },
        }
    }

    /// The limit's reset time has passed.
    pub fn lifted(&self, now: i64) -> bool {
        self.until.is_some_and(|until| until <= now)
    }
}

/// `mark`: the sign-in's mark, when it has one that has not lifted.
pub fn readiness(mark: Option<&PlanLimitMark>, signed_in: bool) -> LoginReadiness {
    match mark {
        _ if !signed_in => LoginReadiness::Out,
        Some(mark) if mark.reason == PlanLimitReason::Expired => LoginReadiness::Out,
        Some(_) => LoginReadiness::Limited,
        None => LoginReadiness::Ready,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sign_in_always_wins_and_an_expired_one_blocks() {
        use BillingRoute as R;
        use SubscriptionState as S;
        assert_eq!(resolve_billing_route(S::SignedIn, true), R::Subscription);
        assert_eq!(resolve_billing_route(S::SignedIn, false), R::Subscription);
        assert_eq!(resolve_billing_route(S::Expired, true), R::Blocked, "never a silent fallback to the key");
        assert_eq!(resolve_billing_route(S::Expired, false), R::Blocked);
        assert_eq!(resolve_billing_route(S::SignedOut, true), R::ApiKey);
        assert_eq!(resolve_billing_route(S::SignedOut, false), R::None);
    }

    fn login(id: &str, email: Option<&str>) -> PlanLoginRecord {
        PlanLoginRecord {
            id: id.into(),
            provider: "anthropic".into(),
            label: default_login_label(email, 0),
            email: email.map(str::to_owned),
            store_dir: format!("/acc/claude-{id}"),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    fn three() -> PlanLoginRegistry {
        PlanLoginRegistry::default()
            .with_login(login("a", None))
            .with_login(login("b", None))
            .with_login(login("c", None))
    }

    #[test]
    fn the_first_login_is_the_default_and_removing_it_hands_the_default_on() {
        let reg = three();
        assert_eq!(reg.default_login("anthropic").map(|l| l.id.as_str()), Some("a"));
        let reg = reg.with_default_login("anthropic", "b").with_auto_switch("anthropic", false);
        assert_eq!(reg.default_login("anthropic").map(|l| l.id.as_str()), Some("b"));
        let reg = reg.without_login("b");
        assert_eq!(reg.defaults.get("anthropic").map(String::as_str), Some("a"), "the oldest one left");
        assert!(!reg.auto_switch("anthropic"), "the switch survives a change of logins");
        let reg = reg.without_login("a").without_login("c");
        assert!(reg.defaults.is_empty() && reg.default_login("anthropic").is_none());
        assert_eq!(reg.clone().without_login("nope"), reg);
        assert!(PlanLoginRegistry::default().auto_switch("anthropic"), "on unless turned off");
    }

    #[test]
    fn a_session_starts_on_the_default_else_the_oldest_that_can_run() {
        let reg = three().with_default_login("anthropic", "b");
        let pick =
            |usable: &[&str]| reg.session_login("anthropic", |l| usable.contains(&l.id.as_str())).map(|l| l.id.clone());
        assert_eq!(pick(&["a", "b", "c"]).as_deref(), Some("b"));
        assert_eq!(pick(&["a", "c"]).as_deref(), Some("a"));
        assert_eq!(pick(&["c"]).as_deref(), Some("c"));
        assert_eq!(pick(&[]), None);
        assert_eq!(reg.session_login("openai", |_| true), None);
    }

    #[test]
    fn with_every_login_at_its_limit_a_limited_one_still_runs() {
        use LoginReadiness as R;
        let reg = three();
        let pick = |a, b, c| {
            reg.runnable_login("anthropic", |l| match l.id.as_str() {
                "a" => a,
                "b" => b,
                _ => c,
            })
            .map(|l| l.id.clone())
        };
        assert_eq!(pick(R::Ready, R::Ready, R::Ready).as_deref(), Some("a"));
        assert_eq!(pick(R::Limited, R::Ready, R::Ready).as_deref(), Some("b"), "a ready one before a limited default");
        assert_eq!(pick(R::Out, R::Limited, R::Limited).as_deref(), Some("b"));
        assert_eq!(pick(R::Out, R::Out, R::Out), None);
    }

    #[test]
    fn a_switch_goes_to_the_login_with_the_most_room() {
        let reg = three().with_default_login("anthropic", "b");
        let target = |usable: &[&str], used: &[(&str, f64)]| {
            reg.switch_target(
                "anthropic",
                |l| usable.contains(&l.id.as_str()),
                |l| used.iter().find(|(id, _)| *id == l.id).map(|(_, u)| *u),
            )
            .map(|l| l.id.clone())
        };
        assert_eq!(target(&["a", "b", "c"], &[("a", 80.0), ("b", 60.0), ("c", 10.0)]).as_deref(), Some("c"));
        assert_eq!(target(&["a", "b", "c"], &[]).as_deref(), Some("b"), "a tie goes to the default");
        assert_eq!(target(&["a", "c"], &[("a", 5.0), ("c", 5.0)]).as_deref(), Some("a"), "then to the oldest");
        assert_eq!(target(&["a", "c"], &[("a", 5.0)]).as_deref(), Some("c"), "unknown use counts as none");
        assert_eq!(target(&[], &[]), None);
    }

    #[test]
    fn logins_are_found_by_email_whatever_its_case() {
        let reg = PlanLoginRegistry::default().with_login(login("a", Some("Ada@Example.com")));
        assert_eq!(reg.find_by_email("anthropic", " ada@example.COM ").map(|l| l.id.as_str()), Some("a"));
        assert!(reg.find_by_email("openai", "ada@example.com").is_none());
        assert_eq!(default_login_label(Some(" ada@example.com "), 3), "ada@example.com");
        assert_eq!(default_login_label(Some("  "), 1), "Account 2");
    }

    #[test]
    fn a_limit_lifts_at_its_reset_and_a_dead_sign_in_stays_out() {
        let limit = PlanLimitMark::new(PlanLimitReason::Limit, Some(5_000), 1_000);
        assert!(!limit.lifted(4_999) && limit.lifted(5_000));
        let unknown = PlanLimitMark::new(PlanLimitReason::Limit, None, 1_000);
        assert_eq!(unknown.until, Some(1_000 + LIMIT_WITHOUT_RESET_MS), "retried after an hour");
        let expired = PlanLimitMark::new(PlanLimitReason::Expired, Some(5_000), 1_000);
        assert!(expired.until.is_none() && !expired.lifted(i64::MAX));

        assert_eq!(readiness(None, true), LoginReadiness::Ready);
        assert_eq!(readiness(Some(&limit), true), LoginReadiness::Limited);
        assert_eq!(readiness(Some(&expired), true), LoginReadiness::Out);
        assert_eq!(readiness(None, false), LoginReadiness::Out);
        assert_eq!(readiness(Some(&limit), false), LoginReadiness::Out);
    }
}
