//! The capability service: one for the whole app, which the agent tools,
//! the permission gateway and the capabilities feature share.

use std::sync::{Arc, OnceLock, Weak};

use eos_capabilities::{Browser, CapabilityPorts, CapabilityService, Notify};
use eos_core::BoxFuture;
use eos_core::agent::UserNotifier;
use eos_core::capability::{
    BuiltinCapability, CapabilityGrants, CapabilitySecrets, ConfineError, ConfineSpec, Confined, Confinement, Grant,
};
use eos_core::delivery::Channels;
use eos_core::net::relay::{PhoneNotify, PhonePush, PushOutcome};
use eos_core::signals::SignalSources;
use eos_core::store::Store;
use eos_core::{Clock, Ids, Sleeper};
use eos_github::{GitHub, Transport};
use eos_mail_app::{MailApp, Script};
use eos_platform::DataPaths;
use eos_store_files::capabilities::FsCapabilityFiles;

use crate::Error;
use crate::reach::Reach;

/// What a test hands the capability service in place of the app's own.
#[derive(Clone, Default)]
pub struct CapabilityOptions {
    /// Where capability secrets are kept: a test's own store. `None`: the
    /// host's [`Options::keychain`](crate::Options::keychain), and none off
    /// the network.
    pub secrets: Option<Arc<dyn CapabilitySecrets>>,
    /// Built-ins beside Eos's own.
    pub builtins: Vec<Arc<dyn BuiltinCapability>>,
    /// How the GitHub capability reaches GitHub: a test's own fake. `None`:
    /// the host's [`Options::github`](crate::Options::github), and nothing
    /// off the network.
    pub github: Option<Arc<dyn Transport>>,
    /// How the Slack capability reaches Slack: a test's own fake. `None`:
    /// the host's [`Options::slack`](crate::Options::slack), and nothing off
    /// the network.
    pub slack: Option<Arc<dyn eos_slack::Transport>>,
    /// How the Mail capability drives Mail: a test's own fake. `None`: the
    /// host's [`Options::mail`](crate::Options::mail), and nothing off the
    /// network.
    pub mail: Option<Arc<dyn Script>>,
    /// The signal sources routines read, in place of the built-ins'.
    pub sources: Option<Arc<dyn SignalSources>>,
    /// The channels results go out through, in place of the built-ins'.
    pub channels: Option<Arc<dyn Channels>>,
}

impl std::fmt::Debug for CapabilityOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapabilityOptions").field("builtins", &self.builtins.len()).finish_non_exhaustive()
    }
}

/// What run sessions may call, as the routines feature grants it once it is
/// built (after the service). Until then, and for every chat, a worker has
/// no grant of its own.
#[derive(Default)]
pub(crate) struct LateGrants(OnceLock<Weak<dyn CapabilityGrants>>);

impl LateGrants {
    pub(crate) fn attach(&self, grants: &Arc<dyn CapabilityGrants>) {
        let _ = self.0.set(Arc::downgrade(grants));
    }
}

impl CapabilityGrants for LateGrants {
    fn grant<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<Grant>> {
        match self.0.get().and_then(Weak::upgrade) {
            Some(grants) => Box::pin(async move { grants.grant(worker_id).await }),
            None => Box::pin(std::future::ready(None)),
        }
    }
}

/// The OS sandbox capability code runs under, attached once the engine is
/// made, after the service. Until then, and without it, nothing is confined,
/// so no package's code runs.
#[derive(Default)]
pub(crate) struct LateConfinement(OnceLock<Weak<dyn Confinement>>);

impl LateConfinement {
    // Held weakly: the engine holds the tools, which hold this service.
    pub(crate) fn attach(&self, confinement: &Arc<dyn Confinement>) {
        let _ = self.0.set(Arc::downgrade(confinement));
    }
}

impl Confinement for LateConfinement {
    fn command(&self, spec: ConfineSpec) -> BoxFuture<'_, Result<Confined, ConfineError>> {
        match self.0.get().and_then(Weak::upgrade) {
            Some(confinement) => Box::pin(async move { confinement.command(spec).await }),
            None => Box::pin(std::future::ready(Err(ConfineError::Unavailable))),
        }
    }
}

/// How the `notify` built-in tells the user, attached once the banner (the
/// questions feature) and the phone link (the remote feature) are built,
/// after the service. Until then nothing is told.
#[derive(Default)]
pub(crate) struct LateNotifiers {
    banner: OnceLock<Arc<dyn UserNotifier>>,
    phone: OnceLock<Arc<dyn PhoneNotify>>,
}

impl LateNotifiers {
    pub(crate) fn attach(&self, banner: Arc<dyn UserNotifier>, phone: Arc<dyn PhoneNotify>) {
        let _ = self.banner.set(banner);
        let _ = self.phone.set(phone);
    }
}

impl UserNotifier for LateNotifiers {
    fn notify(&self, worker_id: &str, title: &str, body: &str) {
        if let Some(banner) = self.banner.get() {
            banner.notify(worker_id, title, body);
        }
    }
}

impl PhoneNotify for LateNotifiers {
    fn push(&self, push: PhonePush) -> BoxFuture<'_, Result<PushOutcome, eos_core::Error>> {
        match self.phone.get() {
            Some(phone) => phone.push(push),
            None => Box::pin(std::future::ready(Ok(PushOutcome::LinkOff))),
        }
    }
}

/// What the service is built from.
pub(crate) struct Parts<'a> {
    pub(crate) reach: Reach,
    pub(crate) paths: &'a DataPaths,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    /// `github.clientId`, read at start.
    pub(crate) github_client_id: String,
    /// `slack.clientId`, read at start.
    pub(crate) slack_client_id: String,
    /// The app's own Keychain items, as the host hands them in.
    pub(crate) keychain: Option<Arc<dyn CapabilitySecrets>>,
    /// How the app reaches GitHub, as the host hands it in.
    pub(crate) github: Option<Arc<dyn Transport>>,
    /// How the app reaches Slack, as the host hands it in.
    pub(crate) slack: Option<Arc<dyn eos_slack::Transport>>,
    /// How the app drives Mail, as the host hands it in.
    pub(crate) mail: Option<Arc<dyn Script>>,
    pub(crate) grants: Arc<LateGrants>,
    pub(crate) notifiers: Arc<LateNotifiers>,
    /// What script packages run under.
    pub(crate) confinement: Arc<LateConfinement>,
    /// The app has a window whose views the browser tools drive.
    pub(crate) views: bool,
    pub(crate) options: CapabilityOptions,
}

/// The packages under `<data folder>/capabilities`, secrets in the app's own
/// Keychain items (none off the network), every installed action granted to
/// every chat and the routines feature's grant to run sessions, the GitHub, Slack and Mail built-ins (which reach GitHub
/// and Slack and drive Mail only on the network), the notify built-in and the browser's entry; script packages run
/// confined by the engine's sandbox.
pub(crate) fn service(parts: Parts<'_>) -> Result<Arc<CapabilityService>, Error> {
    let Parts {
        reach,
        paths,
        store,
        clock,
        ids,
        sleeper,
        github_client_id,
        slack_client_id,
        keychain,
        github,
        slack,
        mail,
        grants,
        notifiers,
        confinement,
        views,
        options,
    } = parts;
    let trash = Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), paths));
    let secrets: Arc<dyn CapabilitySecrets> = options.secrets.unwrap_or_else(|| reach.capabilities(keychain));
    let transport: Arc<dyn Transport> = match options.github {
        Some(transport) => transport,
        None => reach.github(github),
    };
    // Off the network its secrets are empty and its requests go nowhere.
    let github: Arc<dyn BuiltinCapability> = Arc::new(GitHub::new(eos_github::Parts {
        transport,
        secrets: secrets.clone(),
        clock: clock.clone(),
        sleeper: sleeper.clone(),
        client_id: github_client_id,
    }));
    let slack: Arc<dyn BuiltinCapability> = Arc::new(eos_slack::Slack::new(eos_slack::Parts {
        transport: options.slack.unwrap_or_else(|| reach.slack(slack)),
        secrets: secrets.clone(),
        clock: clock.clone(),
        sleeper: sleeper.clone(),
        ids: ids.clone(),
        client_id: slack_client_id,
    }));
    let script = match options.mail {
        Some(script) => script,
        None => reach.mail(mail),
    };
    let mail: Arc<dyn BuiltinCapability> = Arc::new(MailApp::new(eos_mail_app::Parts {
        script,
        clock: clock.clone(),
        sleeper,
        surfaces: paths.join("surfaces"),
    }));
    Ok(Arc::new(CapabilityService::new(
        CapabilityPorts {
            store,
            files: Arc::new(FsCapabilityFiles::new(paths.join("capabilities"), trash)),
            secrets,
            grants,
            runner: Some(Arc::new(eos_capability_host::ScriptHost::new(
                paths.join("capabilities"),
                paths.join("scratch").join("capability-calls"),
                confinement,
                eos_kit_proc::Runner::new(eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
                    eos_platform::kill_process_tree(pid).is_ok()
                })),
                ids.clone(),
            ))),
            clock,
            ids,
        },
        [github, slack, mail, Arc::new(Notify::new(notifiers.clone(), notifiers)), Arc::new(Browser::new(views))]
            .into_iter()
            .chain(options.builtins)
            .collect(),
    )))
}
