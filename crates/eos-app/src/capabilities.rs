//! The capability service: one for the whole app, which the agent tools,
//! the permission gateway and the capabilities feature share.

use std::sync::Arc;

use eos_auth::AppKeychainSecrets;
use eos_capabilities::{CapabilityPorts, CapabilityService};
use eos_core::capability::AllInstalled;
use eos_core::store::Store;
use eos_core::{Clock, Ids};
use eos_platform::DataPaths;
use eos_store_files::capabilities::FsCapabilityFiles;

use crate::reach::Reach;

/// The packages under `<data folder>/capabilities`, secrets in the app's own
/// Keychain items (none off the network), every installed action granted to
/// every chat. No package runner and no built-ins yet.
pub(crate) fn service(
    reach: Reach,
    paths: &DataPaths,
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
) -> Arc<CapabilityService> {
    let trash = Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), paths.trash_dir()));
    Arc::new(CapabilityService::new(
        CapabilityPorts {
            store,
            files: Arc::new(FsCapabilityFiles::new(paths.join("capabilities"), trash)),
            secrets: reach.capabilities(Arc::new(AppKeychainSecrets::host())),
            grants: Arc::new(AllInstalled),
            runner: None,
            clock,
            ids,
        },
        Vec::new(),
    ))
}
