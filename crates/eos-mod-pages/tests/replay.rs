//! The page routes against the recorded wire: every step of `31-pages` must
//! answer what today's daemon answered, events included.

use std::sync::Arc;

use eos_mod_pages::PagesModule;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_files::pages::FilePageStore;
use eos_testkit::wire::{Replay, private_recording};
use eos_testkit::{FakeClock, SeqIds, TempStore};

#[tokio::test(flavor = "multi_thread")]
async fn the_pages_scenario_replays_equal() {
    let sandbox = "/sandbox";
    let temp = TempStore::seeded(sandbox);
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let pages = Arc::new(FilePageStore::open(temp.home.join("pages"), clock.clone()));
    let module = Arc::new(PagesModule::new(pages, temp.port(), clock.clone(), ids, kernel.bus.clone()));
    let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
    assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
    runtime.lifecycle.start().await.expect("started");

    let replay = Replay {
        router: &runtime.router,
        bus: &runtime.kernel.bus,
        clock: &clock,
        vars: &[("sandbox", sandbox)],
        skip: &[],
        only: &[],
    };
    let replayed = replay.run("31-pages").await;
    assert_eq!(replayed.steps, 24);
    // The contract types word a bad union tag their own way (eos-contracts' README).
    let known = [
        "edit-unknown-op: /json/error: recorded \"invalid request: op: Invalid discriminator value. Expected 'append' | 'replace' | 'setTask'\" got \"invalid request: op: Invalid enum value. Expected 'append' | 'replace' | 'setTask', received 'shuffle'\"",
    ];
    let unexpected: Vec<&String> = replayed.differences.iter().filter(|d| !known.contains(&d.as_str())).collect();
    assert!(unexpected.is_empty(), "{unexpected:#?}");
    assert_eq!(replayed.differences.len(), known.len(), "a known difference is gone: drop it from the list");
}

/// The page reads on a private copy of real data answer what today's daemon
/// answered on it. Runs when `EOS_REAL_HOME` names the copy and
/// `EOS_PRIVATE_RECORDINGS` the folder of its recordings; prints where an
/// answer differs, never the data.
#[tokio::test(flavor = "multi_thread")]
async fn the_page_reads_of_a_real_data_folder_replay_equal() {
    let (Some(home), Some(recording)) = (std::env::var_os("EOS_REAL_HOME"), private_recording("20-reads")) else {
        return;
    };
    let temp = TempStore::new();
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let pages = Arc::new(FilePageStore::open(std::path::Path::new(&home).join("pages"), clock.clone()));
    let module = Arc::new(PagesModule::new(pages, temp.port(), clock.clone(), ids, kernel.bus.clone()));
    let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
    let replay = Replay {
        router: &runtime.router,
        bus: &runtime.kernel.bus,
        clock: &clock,
        vars: &[],
        skip: &[],
        only: &["pages", "page"],
    };
    let replayed = replay.run_recording(&recording).await;
    assert_eq!(replayed.steps, 2);
    assert_eq!(replayed.places(), Vec::<&str>::new());
}
