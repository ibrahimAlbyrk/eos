//! What follows the user between their computers: sync, file transfer, and
//! how a project folder is named on the way.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use eos_core::git::ProjectKeys;
use eos_core::net::sync::SyncDomain;
use eos_core::store::{ProjectStore, RecentFolders};
use eos_core::{Clock, Error};
use eos_git::GitProjectKeys;
use eos_kit_net::{ClientOptions, http_client};
use eos_mod_sync::{SyncModule, SyncParts, SyncServiceDeps, Timing};
use eos_mod_transfer::{TransferModule, TransferServiceDeps};
use eos_platform::DataPaths;
use eos_runtime::module::{Module, SyncContribution};
use eos_store_files::sync_dir::FileDirDomain;
use eos_store_sqlite::SqliteStore;
use eos_sync_vault::{FileSyncIdentityStore, FileSyncStateStore, RelayAccounts};
use eos_transfer_fs::{FsTransferEndpoint, FsTransferEndpointDeps};

use crate::modules::Context;

/// How a project folder travels between computers: by its git remote, looked
/// for among the folders this computer knows (projects, recent folders, the
/// agents' folders).
pub(crate) fn project_keys(
    paths: &DataPaths,
    clock: &Arc<dyn Clock>,
    projects: Arc<dyn ProjectStore>,
    recents: Arc<dyn RecentFolders>,
    store: Arc<SqliteStore>,
) -> Arc<dyn ProjectKeys> {
    let known = Arc::new(move || {
        let mut folders: Vec<String> = projects.list().into_iter().flat_map(|project| project.folders).collect();
        folders.extend(recents.list());
        // A short read on the database's reader thread.
        let agents = store.read_blocking(|tx| tx.workers().list_all()).unwrap_or_default();
        for folder in agents.into_iter().filter_map(|worker| worker.worktree_from.or(worker.cwd)) {
            if !folders.contains(&folder) {
                folders.push(folder);
            }
        }
        folders
    });
    Arc::new(GitProjectKeys::new(
        Arc::new(crate::files::git(clock)),
        known,
        paths.join(Path::new("sync").join("project-keys.json")),
        clock.clone(),
    ))
}

/// The name this computer goes by on the user's other ones: the one set for
/// hosting, else the system's. Asked of the system once, when first needed.
fn device_name(cx: &Context) -> eos_mod_sync::DeviceName {
    let config = cx.config.clone();
    let system = Arc::new(OnceLock::new());
    Arc::new(move || {
        config.current().peer.name.clone().unwrap_or_else(|| system.get_or_init(eos_platform::computer_name).clone())
    })
}

/// Sync, over what the other features let follow the user (`contributions`)
/// and the folders of hand-edited files.
pub(crate) fn sync(cx: &Context, contributions: Vec<SyncContribution>) -> Result<Arc<dyn Module>, Error> {
    let dir = cx.paths.join("sync");
    let config = cx.config.clone();
    // The vault is on the relay the user's own key names: no guard for agent-written URLs.
    let http = http_client(&ClientOptions::new("Eos")).unwrap_or_default();
    let folders: Vec<Arc<dyn SyncDomain>> = vec![
        Arc::new(FileDirDomain::templates(cx.paths.join("templates"), cx.clock.clone())),
        Arc::new(FileDirDomain::workers(cx.paths.join("workers"), cx.clock.clone())),
    ];
    let module = SyncModule::new(SyncParts {
        service: SyncServiceDeps {
            identities: Arc::new(FileSyncIdentityStore::new(&dir)),
            state: Arc::new(FileSyncStateStore::new(&dir, cx.clock.clone())),
            accounts: cx.reach.sync_accounts(Arc::new(RelayAccounts::new(http))),
            // A new account is created on the relay hosting uses, else the phone's.
            relay_url: Arc::new(move || {
                let current = config.current();
                current.peer.relay_url.clone().or_else(|| current.remote.relay.as_ref().map(|relay| relay.url.clone()))
            }),
            device: device_name(cx),
            timing: Timing::default(),
        },
        contributions,
        folders,
        project_keys: cx.project_keys.clone(),
        clock: cx.clock.clone(),
        bus: cx.bus.clone(),
        jobs: cx.kernel.jobs.clone(),
    })?;
    Ok(Arc::new(module))
}

/// File transfer: this computer's disk as an endpoint, and the engine.
pub(crate) fn transfer(cx: &Context) -> Arc<TransferModule> {
    let fallback = cx.paths.trash_dir();
    let local = FsTransferEndpoint::new(FsTransferEndpointDeps {
        home: eos_platform::home_dir().unwrap_or_default(),
        // Nothing lands inside Eos's own data.
        forbidden: vec![cx.paths.home().to_owned()],
        // The system Trash; Eos's own trash folder where that is not available.
        trash: Arc::new(move |path| {
            if eos_platform::host().trash(path).is_ok() {
                return Ok(());
            }
            eos_kit_fs::trash_into_dir(path, &fallback).map(drop).map_err(|e| e.to_string())
        }),
        projects: cx.project_keys.clone(),
        clock: cx.clock.clone(),
    });
    Arc::new(TransferModule::new(
        TransferServiceDeps {
            store: cx.store.clone(),
            local: Arc::new(local),
            machines: cx.peer.machines(),
            bus: cx.bus.clone(),
            clock: cx.clock.clone(),
            ids: cx.ids.clone(),
            sleeper: cx.sleeper.clone(),
        },
        cx.kernel.jobs.clone(),
    ))
}
