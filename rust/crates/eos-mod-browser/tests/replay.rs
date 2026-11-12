//! The browser routes against the recorded wire: every step of `17-browser` must answer
//! what today's daemon answered, but for the one thing that changed on purpose.

use std::sync::Arc;

use eos_core::shell::{BrowserPanel, BrowserViews};
use eos_mod_browser::{BrowserModule, Ports};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::wire::Replay;
use eos_testkit::{FakeBrowserPanel, FakeBrowserViews, FakeClock, FakeConfig, FakeSleeper, SeqIds, TempStore};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn the_browser_scenario_replays_equal() {
    let temp = TempStore::seeded("/sandbox");
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids, ..KernelOptions::default() });
    let module = Arc::new(BrowserModule::new(Ports {
        shell: Some((
            FakeBrowserViews::new() as Arc<dyn BrowserViews>,
            FakeBrowserPanel::new() as Arc<dyn BrowserPanel>,
        )),
        config: Arc::new(FakeConfig::new(json!({}))),
        store: temp.port(),
        files: Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), temp.home.join("trash"))),
        clock: clock.clone(),
        sleeper: Arc::new(FakeSleeper::default()),
        bus: kernel.bus.clone(),
    }));
    let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
    assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
    runtime.lifecycle.start().await.expect("started");

    let replay =
        Replay { router: &runtime.router, bus: &runtime.kernel.bus, clock: &clock, vars: &[], skip: &[], only: &[] };
    let replayed = replay.run("17-browser").await;
    assert_eq!(replayed.steps, 11);
    // The recording ran without the app, so the daemon named the Chrome it would have
    // started. The app is its own browser now: there is no other lane.
    let unexpected: Vec<&String> =
        replayed.differences.iter().filter(|d| !d.contains(": /json/chromePath: ")).collect();
    assert!(unexpected.is_empty(), "{unexpected:#?}");
    assert_eq!(replayed.differences.len(), 3, "the three status answers: {:#?}", replayed.differences);
}
