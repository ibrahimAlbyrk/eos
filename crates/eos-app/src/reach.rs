//! What a run may do as the user beyond this computer. One rule, the host's
//! (`eos_bridge::launch::reaches_network`, [`Options::reaches_network`](crate::Options)):
//! only the installed app on the user's own `~/.eos` does. Any other run (a
//! development build, a test, a replay, a copy of a data folder) holds
//! someone's identity, keys and sign-ins and must not act as them by itself.
//! Every service that would is given its connection here, or none:
//!
//! | Service | Off the network |
//! |---|---|
//! | The phone's relay | never dialled |
//! | Wake-up pushes to the phone (`PhoneNotify`) | every push answers `LinkOff`; nothing is dialled |
//! | Paired computers | no listener, no dial |
//! | Sync | its vault refuses every call: nothing is pulled or pushed |
//! | The update feed | updates are off |
//! | Eos's own reads of the user's accounts: plan usage, the artifact catalog, the model list | no sign-in's token is handed out or renewed for them; usage and artifacts say why |
//! | The check of an older install's setup token (`config.anthropic.authToken`) | never asked: the token counts as signed in, as when the network does not answer |
//! | The saved plan usage (`usage-cache.json`, read by the TypeScript app too) | shown as not refreshed, never written |
//! | Capability secrets (the app's own Keychain items: GitHub's sign-in, keys) | an empty store: no capability is signed in, nothing is kept |
//! | GitHub, for its capability's calls, checks and sign-in | every request is refused unsent, as when GitHub does not answer |
//! | The Mail app, for its capability's reads, sends and checks | `osascript` never runs; every program answers as macOS refusing Apple Events, so Mail reads `needs_setup` |
//! | Routine runs nobody started by hand (triggers, agents, other routines) | they wait in the queue; runs the user starts still start |
//! | The capabilities' signal sources (GitHub's pull requests) | every poll answers `off` |
//! | Signals that match a routine | decided `held-dev`: no run is admitted |
//! | The channels a run's results go out through (GitHub reviews) | every send answers `DevRun`: the delivery stays `frozen`, nothing is sent |
//! | Memory's model calls nobody asked for (reflection, night tidying) | they never run; notes come from rules only |
//! | Routines' night read for a routine to suggest | it never runs |
//!
//! Agents are not on the list: they act when the user sends them a message.
//! Each service says why it does nothing in the words or code its answer
//! already has, never as "not signed in" or "not set".

mod channels;

use std::sync::Arc;

use eos_contracts::ProviderUsage;
use eos_contracts::update::UpdateOffReason;
use eos_core::accounts::{PlanStores, StoreLogin, TokenProbe, TokenProbeResult, UsageSnapshotStore};
use eos_core::capability::CapabilitySecrets;
use eos_core::delivery::Channels;
use eos_core::net::relay::{PhoneNotify, PhonePush, PushOutcome as PhonePushOutcome, Relay};
use eos_core::net::sync::{OpenVault, PutOutcome, SyncAccounts, SyncVault, VaultChanges};
use eos_core::signals::{
    FactDecl, PollPage, PollRequest, PushEvent, PushOutcome, Scope, SignalSource, SignalSources, SourceError,
};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncIdentity;
use eos_domain::update::UpdateInstall;
use eos_github::{HttpRequest, HttpResponse, Transport};
use eos_mail_app::{Program, Script, ScriptError};

/// Why sync does nothing on another data folder, as Settings › Sync shows it.
const SYNC_OFF: &str = "Sync runs only in the installed Eos on your own data folder";
/// Why usage and artifacts are not read, as Settings › Usage and the
/// artifact list show it.
const ACCOUNT_READS_OFF: &str = "Only the installed Eos on your own data folder reads your accounts";
/// Why a capability secret is not kept on another data folder.
const SECRETS_OFF: &str = "Only the installed Eos on your own data folder keeps capability secrets";
/// Why GitHub is not asked from another data folder.
const GITHUB_OFF: &str = "only the installed Eos on your own data folder reaches GitHub";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Reach {
    network: bool,
}

impl Reach {
    pub(crate) fn new(network: bool) -> Self {
        Self { network }
    }

    pub(crate) fn relay(self, relay: Option<Arc<dyn Relay>>) -> Option<Arc<dyn Relay>> {
        relay.filter(|_| self.network)
    }

    /// How the user's phone is woken: off the network nobody is asked, and
    /// every push answers that the link is off.
    pub(crate) fn phone_notify(self, notify: Arc<dyn PhoneNotify>) -> Arc<dyn PhoneNotify> {
        if self.network { notify } else { Arc::new(NoPush) }
    }

    /// Whether paired computers may be listened for and dialled.
    pub(crate) fn peers(self) -> bool {
        self.network
    }

    pub(crate) fn sync_accounts(self, accounts: Arc<dyn SyncAccounts>) -> Arc<dyn SyncAccounts> {
        if self.network { accounts } else { Arc::new(NoVault(accounts)) }
    }

    pub(crate) fn update_install(
        self,
        install: Result<UpdateInstall, UpdateOffReason>,
    ) -> Result<UpdateInstall, UpdateOffReason> {
        if self.network { install } else { Err(UpdateOffReason::DevBuild) }
    }

    /// The credential stores as Eos's own reads of the user's accounts use
    /// them. Sign-ins and agents keep the stores themselves.
    pub(crate) fn account_reads(self, stores: Arc<dyn PlanStores>) -> Arc<dyn PlanStores> {
        if self.network { stores } else { Arc::new(NoTokens(stores)) }
    }

    /// Where plan usage is saved between runs. A run that reads none has
    /// nothing to add, and what it would drop is still the user's.
    pub(crate) fn usage_cache(self, cache: Arc<dyn UsageSnapshotStore>) -> Arc<dyn UsageSnapshotStore> {
        if self.network { cache } else { Arc::new(ReadOnly(cache)) }
    }

    /// Where capability secrets are kept: the Keychain items every run on
    /// this computer shares, which only the host hands in, so a run without
    /// them (a test that reaches local fakes) or off the network gets a store
    /// of its own, empty.
    pub(crate) fn capabilities(self, keychain: Option<Arc<dyn CapabilitySecrets>>) -> Arc<dyn CapabilitySecrets> {
        match keychain.filter(|_| self.network) {
            Some(keychain) => keychain,
            None => Arc::new(NoSecrets),
        }
    }

    /// How the GitHub capability reaches GitHub: through the transport only
    /// the host hands in, so a run without it (a test that reaches local
    /// fakes) or off the network sends nothing.
    pub(crate) fn github(self, transport: Option<Arc<dyn Transport>>) -> Arc<dyn Transport> {
        match transport.filter(|_| self.network) {
            Some(transport) => transport,
            None => Arc::new(NoGitHub),
        }
    }

    /// How the Mail capability drives Mail: through the program runner only
    /// the host hands in, so a run without it or off the network never
    /// runs `osascript`.
    pub(crate) fn mail(self, script: Option<Arc<dyn Script>>) -> Arc<dyn Script> {
        match script.filter(|_| self.network) {
            Some(script) => script,
            None => Arc::new(NoMail),
        }
    }

    /// The channels results go out through: off the network each still says
    /// what its actions are, and every call answers `DevRun`.
    pub(crate) fn channels(self, channels: Arc<dyn Channels>) -> Arc<dyn Channels> {
        if self.network { channels } else { Arc::new(channels::OffChannels(channels)) }
    }

    /// The sources signals come from: off the network each still says what
    /// it gives, and every poll and push answers `Off`.
    pub(crate) fn signal_sources(self, sources: Arc<dyn SignalSources>) -> Arc<dyn SignalSources> {
        if self.network { sources } else { Arc::new(OffSources(sources)) }
    }

    /// Whether routine runs the user did not start leave the queue by
    /// themselves, and whether a matched signal admits its run. Off the
    /// network only the user's own starts run, which the dev guard lets
    /// through or refuses.
    pub(crate) fn autostart(self) -> bool {
        self.network
    }

    /// Whether memory and routines may call the model when nobody asked
    /// (reflection, night tidying, the suggestion read): those calls spend
    /// the user's plan.
    pub(crate) fn background_model_calls(self) -> bool {
        self.network
    }

    /// How an older install's setup token is checked: it is sent to Claude.
    pub(crate) fn token_probe(self, probe: Arc<dyn TokenProbe>) -> Arc<dyn TokenProbe> {
        if self.network { probe } else { Arc::new(NoProbe) }
    }
}

/// Capability secrets of a store that keeps none: nothing is set, and a
/// write says why it is refused.
struct NoSecrets;

impl CapabilitySecrets for NoSecrets {
    fn read<'a>(
        &'a self,
        _capability: &'a str,
        _name: &'a str,
    ) -> BoxFuture<'a, Result<Option<zeroize::Zeroizing<String>>, Error>> {
        Box::pin(std::future::ready(Ok(None)))
    }

    fn write<'a>(
        &'a self,
        _capability: &'a str,
        _name: &'a str,
        _value: zeroize::Zeroizing<String>,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(Err(Error::Rule(SECRETS_OFF.into()))))
    }

    fn delete<'a>(&'a self, _capability: &'a str, _name: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn has<'a>(&'a self, _capability: &'a str, _name: &'a str) -> BoxFuture<'a, Result<bool, Error>> {
        Box::pin(std::future::ready(Ok(false)))
    }
}

/// A way to GitHub that sends nothing: every request fails as one that got
/// no answer.
struct NoGitHub;

impl Transport for NoGitHub {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, eos_github::Error>> {
        Box::pin(std::future::ready(Err(eos_github::Error::Transport(GITHUB_OFF.into()))))
    }
}

/// Mail that is never asked: every program answers as a refused Apple Event.
struct NoMail;

impl Script for NoMail {
    fn run(
        &self,
        _program: Program,
        _input: serde_json::Value,
    ) -> BoxFuture<'_, Result<serde_json::Value, ScriptError>> {
        Box::pin(std::future::ready(Err(ScriptError::Denied)))
    }
}

/// Sources that read nothing.
struct OffSources(Arc<dyn SignalSources>);

impl SignalSources for OffSources {
    fn get(&self, source: &str) -> Option<Arc<dyn SignalSource>> {
        self.0.get(source).map(|source| Arc::new(OffSource(source)) as Arc<dyn SignalSource>)
    }
}

struct OffSource(Arc<dyn SignalSource>);

impl SignalSource for OffSource {
    fn facts(&self) -> &[FactDecl] {
        self.0.facts()
    }

    fn interval_ms(&self) -> Option<i64> {
        self.0.interval_ms()
    }

    fn wait_ms(&self) -> u64 {
        self.0.wait_ms()
    }

    fn closes(&self, kind: &str) -> bool {
        self.0.closes(kind)
    }

    fn poll(&self, _request: PollRequest) -> BoxFuture<'_, Result<PollPage, SourceError>> {
        Box::pin(std::future::ready(Err(SourceError::Off)))
    }

    fn accept_push(&self, _scope: &Scope, _event: &PushEvent) -> Result<PushOutcome, SourceError> {
        Err(SourceError::Off)
    }
}

/// Pushes that go nowhere.
struct NoPush;

impl PhoneNotify for NoPush {
    fn push(&self, _push: PhonePush) -> BoxFuture<'_, Result<PhonePushOutcome, Error>> {
        Box::pin(std::future::ready(Ok(PhonePushOutcome::LinkOff)))
    }
}

/// A token check that asks nobody: the answer is the one for no answer.
struct NoProbe;

impl TokenProbe for NoProbe {
    fn probe<'a>(&'a self, _token: &'a str) -> BoxFuture<'a, TokenProbeResult> {
        Box::pin(std::future::ready(TokenProbeResult::Unknown))
    }
}

/// Saved usage that is read and never written.
struct ReadOnly(Arc<dyn UsageSnapshotStore>);

impl UsageSnapshotStore for ReadOnly {
    fn load(&self) -> Vec<ProviderUsage> {
        self.0.load()
    }

    fn save(&self, _snapshots: &[ProviderUsage]) -> Result<(), Error> {
        Ok(())
    }
}

/// Sync accounts whose vault is never reached.
struct NoVault(Arc<dyn SyncAccounts>);

impl SyncAccounts for NoVault {
    fn create(&self, relay_url: &str) -> SyncIdentity {
        self.0.create(relay_url)
    }

    fn open(&self, identity: &SyncIdentity) -> OpenVault {
        let crypto = self.0.open(identity).crypto;
        OpenVault { vault: Arc::new(Refused), crypto }
    }
}

struct Refused;

impl SyncVault for Refused {
    fn changes(&self, _since: u64, _wait_ms: u64) -> BoxFuture<'_, Result<VaultChanges, Error>> {
        Box::pin(std::future::ready(Err(Error::Rule(SYNC_OFF.into()))))
    }

    fn put<'a>(&'a self, _key: &'a str, _base_seq: u64, _data: &'a [u8]) -> BoxFuture<'a, Result<PutOutcome, Error>> {
        Box::pin(std::future::ready(Err(Error::Rule(SYNC_OFF.into()))))
    }
}

/// Stores that say what they hold but hand out no token, and say why.
struct NoTokens(Arc<dyn PlanStores>);

impl PlanStores for NoTokens {
    fn read<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, StoreLogin> {
        self.0.read(provider, store_dir)
    }

    fn access_token<'a>(&'a self, _provider: &'a str, _store_dir: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(None))
    }

    fn refused<'a>(&'a self, _provider: &'a str, _store_dir: &'a str, _rejected: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(std::future::ready(false))
    }

    fn sign_out<'a>(&'a self, provider: &'a str, store_dir: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.0.sign_out(provider, store_dir)
    }

    fn withheld(&self) -> Option<&'static str> {
        Some(ACCOUNT_READS_OFF)
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::update::UpdatePlatform;
    use eos_core::capability::{ActionContext, BuiltinCapability};
    use eos_github::GitHub;
    use eos_testkit::{
        FakeCapabilitySecrets, FakeClock, FakeGitHub, FakePlanStores, FakeSignalSources, FakeSleeper, FakeSource,
        FakeTokenProbe,
    };
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn off_the_network_no_sign_in_hands_out_a_token_for_eos_s_own_reads() {
        let stores = Arc::new(FakePlanStores::default());
        stores.sign_in("/acc/claude", Some("max"), None);
        let off = Reach::new(false).account_reads(stores.clone());
        assert!(off.read("anthropic", "/acc/claude").await.present, "what it holds still shows");
        assert_eq!(off.access_token("anthropic", "/acc/claude").await, None);
        assert!(!off.refused("anthropic", "/acc/claude", "t").await);
        assert_eq!(off.withheld(), Some(ACCOUNT_READS_OFF), "and says why");
        let on = Reach::new(true).account_reads(stores);
        assert!(on.access_token("anthropic", "/acc/claude").await.is_some());
        assert_eq!(on.withheld(), None);
    }

    #[tokio::test]
    async fn off_the_network_an_old_setup_token_is_never_sent_to_be_checked() {
        let probe = Arc::new(FakeTokenProbe::default());
        probe.answer(TokenProbeResult::Rejected);
        let off = Reach::new(false).token_probe(probe.clone());
        assert_eq!(off.probe("setup").await, TokenProbeResult::Unknown, "never read as expired");
        assert_eq!(probe.calls(), 0);
        assert_eq!(Reach::new(true).token_probe(probe.clone()).probe("setup").await, TokenProbeResult::Rejected);
    }

    #[tokio::test]
    async fn off_the_network_the_capability_secret_store_is_empty() {
        let keychain = Arc::new(FakeCapabilitySecrets::new().with("github", "token", "gho_planted_secret_1"));
        let off = Reach::new(false).capabilities(Some(keychain.clone()));
        assert_eq!(off.read("github", "token").await.expect("read"), None);
        assert!(!off.has("github", "token").await.expect("asked"));
        let refused = off.write("github", "token", "gho_other".to_owned().into()).await;
        assert_eq!(refused.map_err(|e| e.to_string()), Err(SECRETS_OFF.to_owned()), "and says why");
        off.delete("github", "token").await.expect("nothing to delete");
        assert!(keychain.has("github", "token").await.expect("asked"), "the real store is left alone");
        let on = Reach::new(true).capabilities(Some(keychain));
        assert!(on.read("github", "token").await.expect("read").is_some());
    }

    #[tokio::test]
    async fn on_the_network_without_the_host_s_keychain_the_capability_secret_store_is_empty() {
        let store = Reach::new(true).capabilities(None);
        assert!(!store.has("github", "token").await.expect("asked"));
        let refused = store.write("github", "token", "gho_other".to_owned().into()).await;
        assert_eq!(refused.map_err(|e| e.to_string()), Err(SECRETS_OFF.to_owned()));
    }

    #[tokio::test]
    async fn off_the_network_github_is_never_sent_a_call_or_a_sign_in() {
        let github = Arc::new(FakeGitHub::new());
        let capability = GitHub::new(eos_github::Parts {
            transport: Reach::new(false).github(Some(github.clone())),
            secrets: Arc::new(FakeCapabilitySecrets::new()),
            clock: Arc::new(FakeClock::at(1_763_460_000_000)),
            sleeper: Arc::new(FakeSleeper::default()),
            client_id: "Iv1.fake".into(),
        });
        let ctx = ActionContext {
            secrets: [("token".to_owned(), "gho_planted_secret_1".to_owned().into())].into(),
            settings: json!({}),
            idempotency_key: None,
        };

        let read = capability.call("get_pull_request", json!({ "repo": "acme/game", "number": 7 }), &ctx).await;
        let sign_in = capability.device_sign_in().expect("GitHub signs in with a code").start().await;

        assert!(read.is_err(), "the call fails as one with no answer");
        assert!(sign_in.is_err(), "and so does the sign-in");
        assert!(github.calls().is_empty(), "nothing reached GitHub");
        assert!(Reach::new(true).github(Some(github.clone())).send(probe()).await.is_ok());
        assert_eq!(github.calls().len(), 1, "on the network it does");
    }

    #[tokio::test]
    async fn on_the_network_without_the_host_s_transport_github_is_never_sent_a_call() {
        let refused = Reach::new(true).github(None).send(probe()).await.map(drop).map_err(|e| e.to_string());
        assert_eq!(refused, Err(eos_github::Error::Transport(GITHUB_OFF.into()).to_string()));
    }

    fn probe() -> HttpRequest {
        HttpRequest {
            method: eos_github::Method::Get,
            url: format!("{}/user", eos_github::API),
            headers: vec![("Authorization".into(), "Bearer gho_planted_secret_1".into())],
            body: None,
        }
    }

    #[tokio::test]
    async fn off_the_network_every_source_answers_off_and_reads_nothing() {
        let fake = Arc::new(FakeSource::new(Vec::new()));
        fake.page(PollPage {
            items: Vec::new(),
            cursor: json!({"etag": "x"}),
            more: false,
            baseline: true,
            poll_after_ms: None,
            retry_at: None,
        });
        let sources = Arc::new(FakeSignalSources::new().with("github.pulls", fake.clone()));
        let request = PollRequest { scope: Scope::new(), cursor: None, wait_ms: 0, focus: None };

        let off = Reach::new(false).signal_sources(sources.clone());
        assert!(off.get("mail.inbox").is_none(), "an unknown source stays unknown");
        let source = off.get("github.pulls").expect("the source");
        assert_eq!(source.poll(request.clone()).await, Err(SourceError::Off));
        let push = PushEvent { headers: Vec::new(), body: Vec::new() };
        assert_eq!(source.accept_push(&Scope::new(), &push), Err(SourceError::Off));
        assert!(fake.requests().is_empty(), "nothing was read");

        let on = Reach::new(true).signal_sources(sources).get("github.pulls").expect("the source");
        assert!(on.poll(request).await.is_ok());
        assert_eq!(fake.requests().len(), 1);
    }

    #[tokio::test]
    async fn off_the_network_a_phone_push_answers_link_off_and_dials_nothing() {
        let phone = Arc::new(eos_testkit::relay::FakePhoneNotify::new());
        let push = PhonePush { kind: eos_core::net::relay::PushKind::NeedsYou, count: 2 };
        let off = Reach::new(false).phone_notify(phone.clone());
        assert_eq!(off.push(push).await, Ok(PhonePushOutcome::LinkOff));
        assert!(phone.pushes().is_empty(), "nothing was asked of the relay");
        assert!(Reach::new(true).phone_notify(phone.clone()).push(push).await.is_ok());
        assert_eq!(phone.pushes(), [push]);
    }

    #[test]
    fn off_the_network_updates_are_off() {
        let release = || {
            Ok(UpdateInstall {
                version: "0.2.0".into(),
                root: "/Applications/Eos.app".into(),
                platform: UpdatePlatform::DarwinArm64,
            })
        };
        assert_eq!(Reach::new(false).update_install(release()), Err(UpdateOffReason::DevBuild));
        assert_eq!(Reach::new(true).update_install(release()), release());
    }
}
