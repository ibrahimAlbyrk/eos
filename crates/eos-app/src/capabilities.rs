//! The capability service: one for the whole app, which the agent tools,
//! the permission gateway and the capabilities feature share.

use std::sync::Arc;

use eos_auth::AppKeychainSecrets;
use eos_capabilities::{CapabilityPorts, CapabilityService};
use eos_core::capability::{AllInstalled, CapabilitySecrets};
use eos_core::store::Store;
use eos_core::{Clock, Ids, Sleeper};
use eos_github::{GitHub, HttpTransport};
use eos_platform::DataPaths;
use eos_store_files::capabilities::FsCapabilityFiles;

use crate::Error;
use crate::reach::Reach;

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
}

/// The packages under `<data folder>/capabilities`, secrets in the app's own
/// Keychain items (none off the network), every installed action granted to
/// every chat, and the GitHub built-in. No package runner yet.
pub(crate) fn service(parts: Parts<'_>) -> Result<Arc<CapabilityService>, Error> {
    let Parts { reach, paths, store, clock, ids, sleeper, github_client_id } = parts;
    let trash = Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), paths.trash_dir()));
    let secrets: Arc<dyn CapabilitySecrets> = reach.capabilities(Arc::new(AppKeychainSecrets::host()));
    // Off the network its secrets are empty: no call carries a token.
    let github = Arc::new(GitHub::new(eos_github::Parts {
        transport: Arc::new(HttpTransport::new()?),
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
            grants: Arc::new(AllInstalled),
            runner: None,
            clock,
            ids,
        },
        vec![github],
    )))
}
