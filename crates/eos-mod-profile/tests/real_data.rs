//! A real profile and its memories render as the TypeScript renders them.
//! Runs when `EOS_REAL_HOME` names a private copy of a data folder that holds
//! `render-expected.json` (what the TypeScript rendered for that copy); reads
//! only, and prints a count, never content.

use std::path::PathBuf;

use eos_contracts::UserMemory;
use eos_profile::{RenderOptions, render_user_profile};
use eos_store_files::memories::parse_user_memory;
use eos_store_files::profile::parse_user_profile;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    text: String,
    tokens: i64,
    included_ids: Vec<String>,
    overflow: usize,
    empty: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    project: Option<String>,
    budget_tokens: i64,
    search_tool_name: Option<String>,
    out: Out,
}

#[derive(Deserialize)]
struct Expected {
    cases: Vec<Case>,
}

#[test]
fn a_real_profile_renders_as_the_typescript_renders_it() {
    let Some(home) = std::env::var_os("EOS_REAL_HOME").map(PathBuf::from) else { return };
    let Ok(expected) = std::fs::read(home.join("render-expected.json")) else { return };
    let expected: Expected = serde_json::from_slice(&expected).expect("render-expected.json");

    let read = |path: PathBuf| std::fs::read_to_string(path).expect("a file of the data folder");
    let mut profile = parse_user_profile(&read(home.join("profile/profile.json"))).expect("the profile");
    let mut files: Vec<PathBuf> = std::fs::read_dir(home.join("profile/memories"))
        .expect("the memories folder")
        .filter_map(|e| Some(e.ok()?.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "md"))
        .collect();
    files.sort();
    let memories: Vec<UserMemory> =
        files.into_iter().map(|path| parse_user_memory(&read(path)).expect("a memory")).collect();

    for (i, case) in expected.cases.iter().enumerate() {
        profile.budget_tokens = case.budget_tokens;
        let options = RenderOptions {
            project: case.project.as_deref(),
            known_lines: &[],
            search_tool_name: case.search_tool_name.as_deref(),
        };
        let got = render_user_profile(&profile, &memories, &options);
        let same = got.text == case.out.text
            && got.tokens == case.out.tokens
            && got.included_ids == case.out.included_ids
            && got.overflow == case.out.overflow
            && got.empty == case.out.empty;
        assert!(same, "real render {i} differs");
    }
    println!("{} real renders match", expected.cases.len());
}

/// The profile and memory reads on a private copy of real data answer what
/// today's daemon answered on it. Runs when `EOS_REAL_HOME` names the copy
/// and `EOS_PRIVATE_RECORDINGS` the folder of its recordings; prints where
/// an answer differs, never the data.
#[tokio::test(flavor = "multi_thread")]
async fn the_profile_reads_of_a_real_data_folder_replay_equal() {
    use std::sync::Arc;

    use eos_mod_profile::{PendingCaps, PreviewContext, ProfileModule, ProfileStores};
    use eos_profile::ProfileBlocks;
    use eos_runtime::router::AllPluginsOn;
    use eos_runtime::{Kernel, KernelOptions, Runtime};
    use eos_store_files::memories::FileUserMemoryStore;
    use eos_store_files::profile::{FileUserAvatarStore, FileUserProfileStore};
    use eos_testkit::wire::{Replay, private_recording};
    use eos_testkit::{FakeClock, FakeMemoryProvider, SeqIds, TempStore};

    let (Some(home), Some(recording)) = (std::env::var_os("EOS_REAL_HOME"), private_recording("20-reads")) else {
        return;
    };
    let dir = PathBuf::from(home).join("profile");
    let temp = TempStore::new();
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let profile = Arc::new(FileUserProfileStore::open(&dir));
    let memories = Arc::new(FileUserMemoryStore::open(dir.join("memories"), clock.clone()));
    let stores = ProfileStores {
        profile: profile.clone(),
        avatars: Arc::new(FileUserAvatarStore::new(&dir)),
        memories: memories.clone(),
        workers: temp.port(),
    };
    // The recording daemon's own home held no CLAUDE.md.
    let preview = PreviewContext {
        blocks: Arc::new(ProfileBlocks::new(profile, memories)),
        memory: Arc::new(FakeMemoryProvider::default()),
        data_home: temp.home.path().to_owned(),
        memory_injected: Arc::new(|| true),
        search_tool_name: "search_memory".into(),
    };
    let module =
        Arc::new(ProfileModule::new(stores, preview, PendingCaps::default(), clock.clone(), ids, kernel.bus.clone()));
    let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
    let replay = Replay {
        router: &runtime.router,
        bus: &runtime.kernel.bus,
        clock: &clock,
        vars: &[],
        skip: &[],
        only: &["profile", "profile-preview", "memories", "memory-search"],
    };
    let replayed = replay.run_recording(&recording).await;
    assert_eq!(replayed.steps, 4);
    assert_eq!(replayed.places(), Vec::<&str>::new());
}
