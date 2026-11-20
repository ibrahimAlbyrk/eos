//! The core's log as the installed app writes it (`eos_kit_log`, every Eos crate at
//! debug), after each area's scripted steps: it tells their story by id, and nothing an
//! area planted reaches the file (`ARCHITECTURE.md`, "What may be logged").
//!
//! One test program with one subscriber, the process's only one: each area is a module
//! whose steps run against one app and hand back what they planted and what the log must
//! tell; the file is read and scanned once, at the end.

#[path = "../support/capabilities.rs"]
mod planted;
#[path = "../support/rig.rs"]
mod rig;
#[path = "../support/routines.rs"]
mod routines_rig;

mod capabilities;
mod chats;
mod inbox;
mod routines;

use std::time::Duration;

use eos_kit_log::Scrubber;
use eos_testkit::{ScriptedRuntime, TempHome};

/// What an area's steps left for the scan.
#[derive(Debug, Default)]
pub(crate) struct Area {
    /// Text that must never reach the log.
    pub(crate) planted: Vec<String>,
    /// Text the log must hold.
    pub(crate) told: Vec<String>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_area_is_told_by_id_and_nothing_private_reaches_the_log() {
    let logs = tempfile::tempdir().expect("a folder");
    let user_home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    assert!(
        eos_kit_log::init_with(Some("warn,eos=debug,eos_agent=warn"), false),
        "the only subscriber of this test binary"
    );
    eos_kit_log::catch_panics();
    eos_kit_log::attach(logs.path(), Scrubber::new(user_home.as_deref()));

    let home = TempHome::new();
    let agents = ScriptedRuntime::new();
    agents.otherwise(rig::turn_for);
    let planted = planted::Planted::plant();
    let app = rig::build_with(home.path(), &agents, planted.options());
    app.start().await.expect("starts");

    let areas = [
        chats::steps(&app).await,
        capabilities::steps(&app, &agents, &planted).await,
        inbox::steps(&app).await,
        routines::steps().await,
    ];

    app.shutdown(Duration::from_secs(5)).await;
    assert!(eos_kit_log::flush(Duration::from_secs(5)));

    let mut text = String::new();
    for entry in std::fs::read_dir(logs.path()).expect("the logs folder") {
        text.push_str(&std::fs::read_to_string(entry.expect("an entry").path()).expect("reads"));
    }
    for planted in areas.iter().flat_map(|area| &area.planted) {
        assert!(!text.contains(planted.as_str()), "{planted} reached the log:\n{}", lines_with(&text, planted));
    }
    if let Some(user) = user_home.as_deref().and_then(|h| h.to_str()).filter(|h| h.len() > 1) {
        assert!(!text.contains(user), "the home folder is written as ~");
    }
    for told in areas.iter().flat_map(|area| &area.told) {
        assert!(text.contains(told.as_str()), "the log tells {told:?}:\n{text}");
    }
    if std::env::var_os("EOS_LOG_TEST_SHOW").is_some() {
        println!("{text}");
    }
}

fn lines_with<'a>(text: &'a str, needle: &str) -> String {
    text.lines().filter(|l| l.contains(needle)).collect::<Vec<&'a str>>().join("\n")
}
