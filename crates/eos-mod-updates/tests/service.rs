//! The update service against in-memory ports.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Setup, harness, rolled_back, set_auto_download, staged_of};
use eos_contracts::update::{
    AppVersion, UpdateApply, UpdateNotice, UpdateNoticeKind, UpdateOffReason, UpdatePhase, UpdatePlatform,
    UpdateRestartRequestWhen,
};
use eos_core::net::updates::UpdateSignals;
use eos_domain::update::{UpdateError, UpdateErrorCode, UpdateInstall};
use eos_mod_updates::{CheckTrigger, DownloadDeps, UpdateDeps, UpdateService};
use eos_testkit::{FAKE_DOWNLOAD_BYTES, FakeBundleIndexer, FakeUpdateSignature};

use UpdatePhase::{Applying, Available, Checking, Downloading, Error, Idle, Off, Ready, Staging, Waiting};

#[tokio::test]
async fn it_checks_downloads_in_the_background_and_becomes_ready() {
    let h = harness(Setup::default());
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phases().await, [Checking, Downloading, Staging, Ready]);
    let ready = h.svc.state();
    assert_eq!(ready.status.version, Some(AppVersion("0.1.3".into())));
    assert_eq!(ready.status.bytes, Some(FAKE_DOWNLOAD_BYTES));
    assert_eq!(ready.status.full, Some(FAKE_DOWNLOAD_BYTES));
    assert_eq!(ready.notes.as_deref(), Some("# notes"));
    assert_eq!(ready.last_checked_at.and_then(|at| at.as_i64()), Some(1_000));
    assert_eq!(ready.current, Some(AppVersion("0.1.2".into())));

    // Progress went out at the start and the end of the download.
    let states = h.states.lock().expect("lock").clone();
    let progress: Vec<(Option<i64>, Option<i64>)> =
        states.iter().filter(|s| s.status.phase == Downloading).map(|s| (s.status.done, s.status.bytes)).collect();
    assert_eq!(
        progress,
        [(Some(0), None), (Some(0), Some(FAKE_DOWNLOAD_BYTES)), (Some(FAKE_DOWNLOAD_BYTES), Some(FAKE_DOWNLOAD_BYTES))]
    );
    assert!(states.iter().all(|s| s.notes.is_none() || s.status.phase == Ready), "notes show only once it is ready");
}

#[tokio::test]
async fn with_auto_download_off_the_release_is_only_offered_and_fetched_on_request() {
    let h = harness(Setup { auto_download_off: true, ..Setup::default() });
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phase(), Available);
    assert!(!h.svc.state().auto_download);
    h.svc.download().await;
    assert_eq!(h.phase(), Ready);
}

#[tokio::test]
async fn it_stays_idle_when_nothing_newer_is_out() {
    let h = harness(Setup { offer: Some(None), ..Setup::default() });
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phases().await, [Checking, Idle]);
}

#[tokio::test]
async fn restart_now_verifies_again_then_hands_the_staged_app_to_the_shell() {
    let h = harness(Setup::default());
    h.svc.check(CheckTrigger::Manual).await;
    assert!(h.svc.restart(UpdateRestartRequestWhen::Now).await);
    assert_eq!(h.phase(), Applying, "applying before the call returns");
    h.settle().await;
    assert_eq!(h.phase(), Applying);
    assert_eq!(
        h.applier.applied(),
        [UpdateApply {
            version: AppVersion("0.1.3".into()),
            from: AppVersion("0.1.2".into()),
            staged: "/u/staged/0.1.3/Eos.app".into(),
            target: "/Applications/Eos.app".into(),
        }]
    );
    assert_eq!(
        h.bundle_check.checks.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "once staged, once more before the swap"
    );
}

#[tokio::test]
async fn it_waits_for_working_agents_then_applies_on_its_own() {
    let h = harness(Setup::default());
    h.svc.check(CheckTrigger::Manual).await;
    h.agents.set(2);
    assert!(h.svc.restart(UpdateRestartRequestWhen::Idle).await);
    assert_eq!((h.phase(), h.svc.state().status.agents), (Waiting, Some(2)));
    assert_eq!(h.svc.state().notes.as_deref(), Some("# notes"));
    h.agents.set(1);
    h.svc.agents_changed().await;
    assert_eq!(h.svc.state().status.agents, Some(1));
    h.agents.set(0);
    h.svc.agents_changed().await;
    h.settle().await;
    assert_eq!(h.applier.applied().len(), 1);

    // With nobody working, "when they finish" is now.
    let idle = harness(Setup::default());
    idle.svc.check(CheckTrigger::Manual).await;
    assert!(idle.svc.restart(UpdateRestartRequestWhen::Idle).await);
    assert_eq!(idle.phase(), Applying);
}

#[tokio::test]
async fn it_goes_back_to_ready_when_waiting_is_called_off() {
    let h = harness(Setup::default());
    h.svc.check(CheckTrigger::Manual).await;
    h.agents.set(1);
    h.svc.restart(UpdateRestartRequestWhen::Idle).await;
    h.svc.later();
    assert_eq!(h.phase(), Ready);
    h.svc.agents_changed().await;
    assert_eq!(h.phase(), Ready, "an agent finishing no longer restarts anything");
    assert!(h.svc.restart(UpdateRestartRequestWhen::Now).await);
}

#[tokio::test]
async fn a_staged_app_that_no_longer_verifies_is_refused_and_it_starts_over() {
    let h = harness(Setup::default());
    h.svc.check(CheckTrigger::Manual).await;
    h.bundle_check.refuse(UpdateError::new(UpdateErrorCode::RejectedBundle, "signature broke"));
    h.svc.restart(UpdateRestartRequestWhen::Now).await;
    h.settle().await;
    assert_eq!(h.phase(), Error);
    assert_eq!(h.svc.state().status.error.as_deref(), Some("signature broke"));
    assert!(h.applier.applied().is_empty());
    assert!(!h.svc.restart(UpdateRestartRequestWhen::Now).await);
    assert!(h.workspace.staged.lock().expect("lock").is_none(), "the staged copy is dropped");
}

#[tokio::test]
async fn a_hand_over_the_shell_cannot_make_is_reported() {
    let h = harness(Setup::default());
    h.svc.check(CheckTrigger::Manual).await;
    *h.applier.fail_with.lock().expect("lock") = Some("the updater could not start: no such file".into());
    h.svc.restart(UpdateRestartRequestWhen::Now).await;
    h.settle().await;
    assert_eq!(h.phase(), Error);
    assert_eq!(h.svc.state().status.error.as_deref(), Some("the updater could not start: no such file"));
}

#[tokio::test]
async fn a_failed_download_is_reported_and_the_next_check_recovers() {
    let h = harness(Setup::default());
    h.feed.fail_manifest_once(UpdateError::network("offline"));
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phase(), Error);
    assert_eq!(h.svc.state().status.error.as_deref(), Some("offline"));
    assert_eq!(h.svc.state().status.version, Some(AppVersion("0.1.3".into())));
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phase(), Ready);
}

#[tokio::test]
async fn a_damaged_range_is_fetched_once_more() {
    let h = harness(Setup::default());
    h.workspace.damage_first_range.store(true, std::sync::atomic::Ordering::SeqCst);
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phase(), Ready);
    assert_eq!(h.feed.range_reads(), 2);
}

#[tokio::test]
async fn a_pointer_whose_signature_does_not_verify_is_an_error() {
    let h = harness(Setup::default());
    let svc = UpdateService::new(UpdateDeps {
        install: Ok(UpdateInstall {
            version: "0.1.2".into(),
            root: "/Applications/Eos.app".into(),
            platform: UpdatePlatform::DarwinArm64,
        }),
        download: DownloadDeps {
            feed: h.feed.clone(),
            indexer: Arc::new(FakeBundleIndexer),
            workspace: h.workspace.clone(),
            bundle_check: h.bundle_check.clone(),
        },
        signature: Arc::new(FakeUpdateSignature(false)),
        agents: h.agents.clone(),
        applier: h.applier.clone(),
        config: h.config.clone(),
        bus: h.kernel.bus.clone(),
        clock: h.clock.clone(),
        spread: Arc::new(|| 0.0),
    });
    svc.check(CheckTrigger::Manual).await;
    assert_eq!(svc.state().status.phase, Error);
    assert_eq!(svc.state().status.error.as_deref(), Some("the release pointer's signature does not verify"));
    assert_eq!(h.feed.range_reads(), 0, "nothing is fetched on the word of an unsigned pointer");
}

#[tokio::test]
async fn switching_auto_download_off_stops_a_download_and_on_starts_what_was_offered() {
    let h = harness(Setup::default());
    h.feed.hold_ranges();
    h.svc.check_in_background(CheckTrigger::Manual);
    assert_eq!(h.phase(), Checking, "checking before the call returns");
    h.feed.range_requested().await;
    assert_eq!(h.phase(), Downloading);

    set_auto_download(&h.config, false);
    h.svc.settings_changed();
    h.settle().await;
    assert_eq!(h.phase(), Available);
    assert_eq!(h.svc.state().status.version, Some(AppVersion("0.1.3".into())));

    // Back on: what was only offered is fetched (and held by the fake again).
    set_auto_download(&h.config, true);
    h.svc.settings_changed();
    assert_eq!(h.phase(), Downloading, "downloading before the call returns");
}

#[tokio::test]
async fn a_version_staged_before_the_restart_is_picked_up_with_how_the_last_swap_ended() {
    let h = harness(Setup { staged: Some(staged_of("0.1.3")), result: Some(rolled_back(false)), ..Setup::default() });
    h.svc.start().await.expect("started");
    h.svc.stop();
    assert_eq!(h.phase(), Ready);
    assert_eq!(h.svc.state().notice, Some(rolled_back(false).notice));
    assert_eq!(h.workspace.last_version.lock().expect("lock").as_deref(), Some("0.1.2"));
    h.svc.dismiss_notice().await;
    assert_eq!(h.svc.state().notice, None);
    assert!(h.workspace.result.lock().expect("lock").as_ref().expect("kept").dismissed);
}

#[tokio::test]
async fn a_staged_version_that_is_not_newer_is_cleared_at_start() {
    let h = harness(Setup { staged: Some(staged_of("0.1.2")), offer: Some(None), ..Setup::default() });
    h.svc.start().await.expect("started");
    h.svc.stop();
    assert_eq!(h.phase(), Idle);
    assert!(h.workspace.staged.lock().expect("lock").is_none());
}

#[tokio::test]
async fn a_rolled_back_version_is_never_fetched_on_its_own() {
    let h = harness(Setup { result: Some(rolled_back(true)), ..Setup::default() });
    h.svc.start().await.expect("started");
    h.svc.stop();
    assert_eq!(h.svc.state().notice, None, "a dismissed notice stays hidden");
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phase(), Available);
    h.feed.offer(Some("0.1.4"));
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.phase(), Ready);
    assert_eq!(h.svc.state().status.version, Some(AppVersion("0.1.4".into())));
}

#[tokio::test]
async fn it_says_it_was_updated_when_a_newer_version_runs_than_last_time() {
    let h = harness(Setup { last_version: Some("0.1.1"), offer: Some(None), ..Setup::default() });
    h.svc.start().await.expect("started");
    h.svc.stop();
    assert_eq!(
        h.svc.state().notice,
        Some(UpdateNotice {
            kind: UpdateNoticeKind::Updated,
            version: AppVersion("0.1.2".into()),
            from: AppVersion("0.1.1".into()),
        })
    );
    let same = harness(Setup { last_version: Some("0.1.2"), offer: Some(None), ..Setup::default() });
    same.svc.start().await.expect("started");
    same.svc.stop();
    assert_eq!(same.svc.state().notice, None);
}

#[tokio::test]
async fn it_looks_when_the_window_shows_or_the_mac_wakes_unless_it_looked_minutes_ago() {
    let h = harness(Setup { offer: Some(None), ..Setup::default() });
    h.svc.check(CheckTrigger::Opened).await;
    h.svc.check(CheckTrigger::Woke).await;
    assert_eq!(h.feed.checks(), 1);
    h.svc.check(CheckTrigger::Manual).await;
    assert_eq!(h.feed.checks(), 2, "Check now always looks");
    h.clock.advance(11 * 60_000);
    h.svc.check(CheckTrigger::Opened).await;
    assert_eq!(h.feed.checks(), 3);

    // The same two signals as the shell sends them.
    h.clock.advance(11 * 60_000);
    h.svc.window_shown();
    h.svc.woke();
    h.settle().await;
    assert_eq!(h.feed.checks(), 4);
}

#[tokio::test]
async fn two_nudges_arriving_together_run_one_check() {
    let h = harness(Setup { offer: Some(None), ..Setup::default() });
    tokio::join!(
        h.svc.check(CheckTrigger::Opened),
        h.svc.check(CheckTrigger::Opened),
        h.svc.check(CheckTrigger::Manual)
    );
    assert_eq!(h.feed.checks(), 1);
}

#[tokio::test(start_paused = true)]
async fn it_checks_soon_after_start_then_about_every_half_hour() {
    let h = harness(Setup { offer: Some(None), ..Setup::default() });
    h.svc.start().await.expect("started");
    tokio::time::sleep(Duration::from_secs(29)).await;
    h.settle().await;
    assert_eq!(h.feed.checks(), 0);
    tokio::time::sleep(Duration::from_secs(1)).await;
    h.settle().await;
    assert_eq!(h.feed.checks(), 1);
    // The lowest spread: 20 % under half an hour, counted from that check.
    tokio::time::sleep(Duration::from_secs(24 * 60 - 1)).await;
    h.settle().await;
    assert_eq!(h.feed.checks(), 1, "not before 24 minutes");
    tokio::time::sleep(Duration::from_secs(1)).await;
    h.settle().await;
    assert_eq!(h.feed.checks(), 2);
    h.svc.stop();
    tokio::time::sleep(Duration::from_secs(3600)).await;
    h.settle().await;
    assert_eq!(h.feed.checks(), 2, "a stopped service checks no more");
}

#[tokio::test(start_paused = true)]
async fn an_app_that_is_still_up_long_after_the_hand_over_did_not_take_it() {
    let h = harness(Setup::default());
    h.svc.start().await.expect("started");
    h.svc.check(CheckTrigger::Manual).await;
    h.svc.restart(UpdateRestartRequestWhen::Now).await;
    h.settle().await;
    assert_eq!(h.phase(), Applying);
    tokio::time::sleep(Duration::from_secs(91)).await;
    h.settle().await;
    assert_eq!(h.phase(), Error);
    assert_eq!(
        h.svc.state().status.error.as_deref(),
        Some("Eos didn't restart. Quit and open it again to finish the update.")
    );
    h.svc.stop();
}

#[tokio::test]
async fn a_build_from_source_is_off_and_stays_off() {
    let h = harness(Setup { off: Some(UpdateOffReason::DevBuild), ..Setup::default() });
    h.svc.start().await.expect("started");
    let state = h.svc.state();
    assert_eq!((state.status.phase, state.status.off, state.current), (Off, Some(UpdateOffReason::DevBuild), None));

    h.svc.check(CheckTrigger::Manual).await;
    h.svc.window_shown();
    h.svc.download().await;
    assert!(!h.svc.restart(UpdateRestartRequestWhen::Now).await);
    h.svc.later();
    h.settle().await;
    assert_eq!(h.phase(), Off);
    assert_eq!(h.feed.checks(), 0, "the feed is never asked");
    assert!(h.workspace.last_version.lock().expect("lock").is_none(), "the update folder is not touched");
}
