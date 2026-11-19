//! The capability service: one for the whole app, which the agent tools,
//! the permission gateway and the capabilities feature share.

use std::sync::{Arc, OnceLock, Weak};

use eos_capabilities::{CapabilityPorts, CapabilityService};
use eos_core::BoxFuture;
use eos_core::capability::{BuiltinCapability, CapabilityGrants, CapabilitySecrets, Grant};
use eos_core::store::Store;
use eos_core::{Clock, Ids, Sleeper};
use eos_github::{GitHub, Transport};
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
    /// The app's own Keychain items, as the host hands them in.
    pub(crate) keychain: Option<Arc<dyn CapabilitySecrets>>,
    /// How the app reaches GitHub, as the host hands it in.
    pub(crate) github: Option<Arc<dyn Transport>>,
    pub(crate) grants: Arc<LateGrants>,
    pub(crate) options: CapabilityOptions,
}

/// The packages under `<data folder>/capabilities`, secrets in the app's own
/// Keychain items (none off the network), every installed action granted to
/// every chat and the routines feature's grant to run sessions, and the GitHub built-in (which reaches GitHub only on the
/// network). No package runner yet.
pub(crate) fn service(parts: Parts<'_>) -> Result<Arc<CapabilityService>, Error> {
    let Parts { reach, paths, store, clock, ids, sleeper, github_client_id, keychain, github, grants, options } = parts;
    let trash = Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), paths.trash_dir()));
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
        sleeper,
        client_id: github_client_id,
    }));
    Ok(Arc::new(CapabilityService::new(
        CapabilityPorts {
            store,
            files: Arc::new(FsCapabilityFiles::new(paths.join("capabilities"), trash)),
            secrets,
            grants,
            runner: None,
            clock,
            ids,
        },
        std::iter::once(github).chain(options.builtins).collect(),
    )))
}
