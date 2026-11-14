//! The profile and memory routes against the recorded wire: every step of
//! `32-profile` that is theirs must answer what today's daemon answered,
//! events included.

use std::sync::Arc;

use eos_contracts::{MemorySource, Num};
use eos_domain::memory_sources::resolve_memory_sources;
use eos_mod_profile::{PendingCaps, PreviewContext, ProfileModule, ProfileStores};
use eos_profile::ProfileBlocks;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_files::claude_md::FileMemoryProvider;
use eos_store_files::memories::FileUserMemoryStore;
use eos_store_files::profile::{FileUserAvatarStore, FileUserProfileStore};
use eos_testkit::wire::Replay;
use eos_testkit::{FakeClock, SeqIds, TempHome, TempStore};

/// The built-in memory source of `config.memory.sources`.
fn claude_source() -> MemorySource {
    MemorySource {
        enabled: Some(true),
        label: Some("CLAUDE.md".into()),
        user_paths: Some(vec!["~/.claude/CLAUDE.md".into()]),
        project_filenames: Some(vec!["CLAUDE.md".into()]),
        priority: Some(Num(0.0)),
        assume_native_for: Some(vec!["claude".into()]),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_profile_scenario_replays_equal() {
    let sandbox = "/sandbox";
    let temp = TempStore::seeded(sandbox);
    // The recording's user home: one CLAUDE.md.
    let user = TempHome::new();
    let seed = eos_testkit::fixtures::wire_dir().join("seed/user/.claude/CLAUDE.md");
    user.write(".claude/CLAUDE.md", std::fs::read(seed).expect("the seeded CLAUDE.md"));
    let user_home = user.path().to_string_lossy().into_owned();

    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let dir = temp.home.join("profile");
    let profile = Arc::new(FileUserProfileStore::open(&dir));
    let memories = Arc::new(FileUserMemoryStore::open(dir.join("memories"), clock.clone()));
    let stores = ProfileStores {
        profile: profile.clone(),
        avatars: Arc::new(FileUserAvatarStore::new(&dir)),
        memories: memories.clone(),
        workers: temp.port(),
    };
    let preview = PreviewContext {
        blocks: Arc::new(ProfileBlocks::new(profile, memories)),
        memory: Arc::new(FileMemoryProvider::new(resolve_memory_sources([("claude", &claude_source())]), user.path())),
        data_home: temp.home.path().to_owned(),
        memory_injected: Arc::new(|| true),
        search_tool_name: "search_memory".into(),
    };
    let module =
        Arc::new(ProfileModule::new(stores, preview, PendingCaps::default(), clock.clone(), ids, kernel.bus.clone()));
    let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
    assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
    runtime.lifecycle.start().await.expect("started");

    let replay = Replay {
        router: &runtime.router,
        bus: &runtime.kernel.bus,
        clock: &clock,
        vars: &[("sandbox", sandbox), ("user_home", &user_home)],
        // Claude Code's own project memory (`/workers/:id/memory`): another feature's routes.
        skip: &[
            "project-memory-of-chat",
            "project-memory-no-folder",
            "project-memory-delete",
            "project-memory-delete-without-token",
            "project-memory-after-delete",
            "project-memory-delete-unknown",
        ],
        only: &[],
    };
    let replayed = replay.run("32-profile").await;
    assert_eq!(replayed.steps, 39);
    // The contract types stop at the first type error where Zod lists every issue (eos-contracts' README).
    let known = [
        "memory-create-invalid: /json/error: recorded \"invalid request: text: String must contain at least 1 character(s); category: Invalid enum value. Expected 'about' | 'work-style' | 'stack' | 'other', received 'nonsense'\" got \"invalid request: category: Invalid enum value. Expected 'about' | 'work-style' | 'stack' | 'other', received 'nonsense'\"",
    ];
    assert_eq!(replayed.differences, known);
}
