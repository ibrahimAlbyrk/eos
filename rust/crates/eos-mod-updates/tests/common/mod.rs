//! What the update tests share: the service over in-memory ports.

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use eos_config::ConfigFile;
use eos_contracts::update::{
    AppVersion, UpdateNotice, UpdateNoticeKind, UpdateOffReason, UpdatePhase, UpdatePlatform, UpdateState,
};
use eos_core::net::updates::SwapResult;
use eos_core::store::ConfigSource;
use eos_domain::config::Env;
use eos_domain::update::{StagedUpdate, UpdateInstall};
use eos_mod_updates::{DownloadDeps, UPDATE_CHANGE, UpdateDeps, UpdateService};
use eos_runtime::bus::Subscription;
use eos_runtime::{Kernel, KernelOptions};
use eos_testkit::{
    FAKE_DOWNLOAD_BYTES, FakeBundleCheck, FakeBundleIndexer, FakeClock, FakeTopLevelAgents, FakeUpdateApplier,
    FakeUpdateFeed, FakeUpdateSignature, FakeUpdateWorkspace, TempHome,
};

pub(crate) struct Harness {
    pub(crate) svc: Arc<UpdateService>,
    pub(crate) feed: Arc<FakeUpdateFeed>,
    pub(crate) workspace: Arc<FakeUpdateWorkspace>,
    pub(crate) bundle_check: Arc<FakeBundleCheck>,
    pub(crate) agents: Arc<FakeTopLevelAgents>,
    pub(crate) applier: Arc<FakeUpdateApplier>,
    pub(crate) config: Arc<ConfigFile>,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) kernel: Kernel,
    pub(crate) states: Arc<Mutex<Vec<UpdateState>>>,
    pub(crate) _listening: Subscription,
    pub(crate) _home: TempHome,
}

#[derive(Default)]
pub(crate) struct Setup {
    /// `None`: 0.1.3 is offered. `Some(None)`: nothing is.
    pub(crate) offer: Option<Option<&'static str>>,
    pub(crate) auto_download_off: bool,
    pub(crate) staged: Option<StagedUpdate>,
    pub(crate) result: Option<SwapResult>,
    pub(crate) last_version: Option<&'static str>,
    pub(crate) off: Option<UpdateOffReason>,
}

pub(crate) fn staged_of(version: &str) -> StagedUpdate {
    StagedUpdate {
        version: version.into(),
        path: format!("/u/staged/{version}/Eos.app"),
        bytes: FAKE_DOWNLOAD_BYTES,
        full: FAKE_DOWNLOAD_BYTES,
        notes: Some("# notes".into()),
    }
}

pub(crate) fn rolled_back(dismissed: bool) -> SwapResult {
    SwapResult {
        notice: UpdateNotice {
            kind: UpdateNoticeKind::RolledBack,
            version: AppVersion("0.1.3".into()),
            from: AppVersion("0.1.2".into()),
        },
        dismissed,
    }
}

pub(crate) fn harness(setup: Setup) -> Harness {
    let home = TempHome::new();
    let config = Arc::new(ConfigFile::load(home.path(), Env::default(), false));
    if setup.auto_download_off {
        set_auto_download(&config, false);
    }
    let clock = Arc::new(FakeClock::at(1_000));
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
    let feed = FakeUpdateFeed::offering(setup.offer.unwrap_or(Some("0.1.3")));
    feed.with_notes("# notes");
    let workspace = Arc::new(FakeUpdateWorkspace::default());
    *workspace.staged.lock().expect("lock") = setup.staged;
    *workspace.result.lock().expect("lock") = setup.result;
    *workspace.last_version.lock().expect("lock") = setup.last_version.map(str::to_owned);
    let bundle_check = Arc::new(FakeBundleCheck::default());
    let agents = Arc::new(FakeTopLevelAgents::default());
    let applier = Arc::new(FakeUpdateApplier::default());

    let states = Arc::new(Mutex::new(Vec::new()));
    let seen = states.clone();
    let listening = kernel.bus.on(&UPDATE_CHANGE, move |event| {
        seen.lock().expect("lock").push(event.payload_as::<UpdateState>().expect("an update state"));
    });
    let install = match setup.off {
        Some(off) => Err(off),
        None => Ok(UpdateInstall {
            version: "0.1.2".into(),
            root: "/Applications/Eos.app".into(),
            platform: UpdatePlatform::DarwinArm64,
        }),
    };
    let svc = UpdateService::new(UpdateDeps {
        install,
        download: DownloadDeps {
            feed: feed.clone(),
            indexer: Arc::new(FakeBundleIndexer),
            workspace: workspace.clone(),
            bundle_check: bundle_check.clone(),
        },
        signature: Arc::new(FakeUpdateSignature(true)),
        agents: agents.clone(),
        applier: applier.clone(),
        config: config.clone(),
        bus: kernel.bus.clone(),
        clock: clock.clone(),
        spread: Arc::new(|| 0.0),
    });
    Harness {
        svc,
        feed,
        workspace,
        bundle_check,
        agents,
        applier,
        config,
        clock,
        kernel,
        states,
        _listening: listening,
        _home: home,
    }
}

pub(crate) fn set_auto_download(config: &ConfigFile, on: bool) {
    let mut patch = serde_json::Map::new();
    patch.insert("autoDownload".into(), serde_json::Value::Bool(on));
    config.patch("updates", patch).expect("config written");
}

impl Harness {
    pub(crate) fn phase(&self) -> UpdatePhase {
        self.svc.state().status.phase
    }

    /// Every phase announced so far, without repeats in a row.
    pub(crate) async fn phases(&self) -> Vec<UpdatePhase> {
        self.kernel.bus.flush().await;
        let mut phases: Vec<UpdatePhase> = self.states.lock().expect("lock").iter().map(|s| s.status.phase).collect();
        phases.dedup();
        phases
    }

    /// Lets the work a call left running come to rest.
    pub(crate) async fn settle(&self) {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }
}
