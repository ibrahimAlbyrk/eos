//! In-app updates over their adapters: the signed feed, the update folder
//! under the data folder, the system's bundle check, and the hand-over to the
//! applier the window shell provides.
//!
//! Only a release build updates itself. A build that is not one (a run from
//! `target/`, a development bundle, every test) is "off": it never asks the
//! feed and never touches the update folder or the user's launchd session.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_contracts::WorkerState;
use eos_contracts::update::{UPDATE_FEED_URL, UpdateApply, UpdateOffReason};
use eos_core::net::updates::{TopLevelAgents, UpdateApplier, UpdateSignals};
use eos_core::store::{ConfigSource, Store};
use eos_core::{BoxFuture, Clock};
use eos_domain::update::UpdateInstall;
use eos_mod_updates::{DownloadDeps, UpdateDeps, UpdateService, UpdatesModule};
use eos_platform::DataPaths;
use eos_runtime::Kernel;
use eos_runtime::module::Module;
use eos_update::handover::BootMark;
use eos_update::legacy::{self, Launchd, LegacyDaemon};
use eos_update::{Ed25519Keys, FsBundleIndexer, FsUpdateWorkspace, HttpUpdateFeed, PlatformBundleCheck, handover};

use crate::Error;

/// The install this run may update, resolved once before anything is opened.
pub(crate) struct Install {
    install: Result<UpdateInstall, UpdateOffReason>,
    /// The release build runs on the user's own data folder (`~/.eos`).
    own_home: bool,
    home: PathBuf,
}

impl Install {
    pub(crate) fn resolve(exec_path: Option<&Path>, paths: &DataPaths) -> Self {
        let platform = eos_platform::host().app_updates();
        let install = match exec_path {
            Some(exec_path) => eos_update::resolve_install(platform, exec_path),
            None => Err(UpdateOffReason::DevBuild),
        };
        let own_home = eos_platform::home_dir().is_some_and(|home| home.join(".eos") == paths.home());
        Self { install, own_home, home: paths.home().to_owned() }
    }

    /// Stops the daemon the TypeScript-era app left under launchd, before the
    /// data folder is opened: two programs must not work on it at once. Only a
    /// release build on the user's own data folder does this — nothing else
    /// may reach into the user's launchd session.
    pub(crate) fn retire_legacy_daemon(&self, launchd: Option<&(dyn Launchd + Send + Sync)>) {
        let (Ok(_), true, Some(launchd)) = (&self.install, self.own_home, launchd) else { return };
        match legacy::stop_legacy_daemon(launchd, legacy::LEGACY_DAEMON_STOP_TIMEOUT) {
            LegacyDaemon::NotLoaded => {}
            LegacyDaemon::Stopped => tracing::info!("stopped the daemon of the previous Eos"),
            LegacyDaemon::StillStopping => {
                tracing::warn!("the daemon of the previous Eos has not stopped yet; going on")
            }
        }
    }
}

/// The updater as the app holds it.
pub(crate) struct Updates {
    service: Arc<UpdateService>,
    install: Install,
    updates_dir: PathBuf,
}

pub(crate) struct Parts<'a> {
    pub(crate) install: Install,
    pub(crate) paths: &'a DataPaths,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) kernel: &'a Kernel,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) applier: Option<Arc<dyn UpdateApplier>>,
}

pub(crate) fn build(parts: Parts<'_>) -> Result<Arc<Updates>, Error> {
    let Parts { install, paths, config, store, kernel, clock, applier } = parts;
    let updates_dir = paths.join("updates");
    let platform = eos_platform::host().app_updates();
    let file_modes = platform.is_none_or(|platform| platform.file_modes());
    let feed_config = config.clone();
    let base_url =
        Arc::new(move || feed_config.current().updates.feed_url.clone().unwrap_or_else(|| UPDATE_FEED_URL.to_owned()));
    let feed = HttpUpdateFeed::new(base_url).map_err(eos_core::Error::storage)?;
    let service = UpdateService::new(UpdateDeps {
        install: install.install.clone(),
        download: DownloadDeps {
            feed: Arc::new(feed),
            indexer: Arc::new(FsBundleIndexer),
            workspace: Arc::new(FsUpdateWorkspace::new(&updates_dir, file_modes)),
            bundle_check: Arc::new(PlatformBundleCheck::new(platform)),
        },
        signature: Arc::new(Ed25519Keys::trusted().map_err(eos_core::Error::storage)?),
        agents: Arc::new(WorkingAgents(store)),
        applier: applier.unwrap_or_else(|| Arc::new(NoApplier)),
        config,
        bus: kernel.bus.clone(),
        clock,
        spread: Arc::new(random_unit),
    });
    Ok(Arc::new(Updates { service, install, updates_dir }))
}

/// A number in `[0, 1)`: where an install's next check falls in its spread.
fn random_unit() -> f64 {
    let mut bytes = [0u8; 4];
    match getrandom::fill(&mut bytes) {
        Ok(()) => f64::from(u32::from_le_bytes(bytes)) / (f64::from(u32::MAX) + 1.0),
        Err(_) => 0.5,
    }
}

impl Updates {
    pub(crate) fn module(&self, config: Arc<dyn ConfigSource>, kernel: &Kernel) -> Arc<dyn Module> {
        Arc::new(UpdatesModule::new(self.service.clone(), config, kernel.bus.clone(), kernel.jobs.clone()))
    }

    /// What the window shell tells the updater.
    pub(crate) fn signals(&self) -> Arc<dyn UpdateSignals> {
        self.service.clone()
    }

    /// Tells a waiting applier that this version is up, then removes what
    /// only the previous version needed. See `App::mark_update_booted`.
    pub(crate) fn mark_booted(&self) {
        let Ok(install) = &self.install.install else { return };
        match handover::mark_booted(&self.updates_dir, &install.version) {
            Ok(BootMark::Written) => {
                tracing::info!(version = %install.version, "told the update applier this version is up");
            }
            Ok(BootMark::NotWaited) => {}
            // The previous version is coming back: leave what it needs.
            Ok(BootMark::Withheld) => {
                tracing::warn!("a rollback rehearsal is on: the update applier is not told this version is up");
                return;
            }
            Err(e) => {
                tracing::error!(error = %e, "the update applier could not be told this version is up");
                return;
            }
        }
        if self.install.own_home
            && let Err(e) = legacy::remove_legacy_plist(&self.install.home)
        {
            tracing::warn!(error = %e, "the previous Eos's daemon plist could not be removed");
        }
    }
}

/// Top-level agents in a turn, read from the worker rows. The sessions side
/// takes this over once it tracks turns itself.
struct WorkingAgents(Arc<dyn Store>);

impl TopLevelAgents for WorkingAgents {
    fn working(&self) -> BoxFuture<'_, usize> {
        Box::pin(async move {
            let active = self.0.read(|tx| tx.workers().list_active()).await;
            active.map_or(0, |workers| {
                workers.iter().filter(|w| w.parent_id.is_none() && w.state == WorkerState::Working).count()
            })
        })
    }
}

/// A run without a window shell cannot quit into the applier.
struct NoApplier;

impl UpdateApplier for NoApplier {
    fn apply<'a>(&'a self, _apply: &'a UpdateApply) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(std::future::ready(Err("This Eos cannot restart itself to update.".to_owned())))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use eos_contracts::update::UpdatePlatform;

    use super::*;

    /// A launchd session that only counts what it is asked.
    #[derive(Default)]
    struct CountingLaunchd {
        bootouts: AtomicUsize,
        looks: AtomicUsize,
    }

    impl Launchd for CountingLaunchd {
        fn loaded(&self, _label: &str) -> bool {
            self.looks.fetch_add(1, Ordering::SeqCst);
            false
        }

        fn bootout(&self, label: &str) -> bool {
            assert_eq!(label, legacy::LEGACY_DAEMON_LABEL);
            self.bootouts.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    fn release() -> Result<UpdateInstall, UpdateOffReason> {
        Ok(UpdateInstall {
            version: "0.2.0".into(),
            root: "/Applications/Eos.app".into(),
            platform: UpdatePlatform::DarwinArm64,
        })
    }

    #[test]
    fn only_a_release_build_on_the_users_own_data_folder_stops_the_old_daemon() {
        let asked = |install: Result<UpdateInstall, UpdateOffReason>, own_home: bool| {
            let launchd = CountingLaunchd::default();
            Install { install, own_home, home: PathBuf::from("/nowhere") }.retire_legacy_daemon(Some(&launchd));
            launchd.bootouts.load(Ordering::SeqCst)
        };
        assert_eq!(asked(release(), true), 1);
        assert_eq!(asked(release(), false), 0, "a release build on another data folder is an isolated run");
        assert_eq!(asked(Err(UpdateOffReason::DevBuild), true), 0, "a build from source never touches launchd");
        assert_eq!(asked(Err(UpdateOffReason::ReadOnly), true), 0);
        // And with no launchd session there is nothing to ask.
        Install { install: release(), own_home: true, home: PathBuf::from("/nowhere") }.retire_legacy_daemon(None);
    }

    #[test]
    fn a_test_run_is_never_a_release_build() {
        let home = eos_testkit::TempHome::new();
        let exe = std::env::current_exe().expect("this test binary");
        let install = Install::resolve(Some(&exe), &home.paths());
        assert_eq!(install.install, Err(UpdateOffReason::DevBuild));
        assert!(!install.own_home);
        assert_eq!(Install::resolve(None, &home.paths()).install, Err(UpdateOffReason::DevBuild));
    }
}
