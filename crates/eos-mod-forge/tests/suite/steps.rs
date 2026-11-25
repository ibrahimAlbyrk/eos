use std::sync::Arc;

use eos_core::routine::SystemSteps;
use eos_mod_forge::{ForgeSteps, REGISTRY_HOSTS, build_folder};
use eos_testkit::{FakeConfinement, TempHome, TempStore};

fn steps(home: &TempHome) -> ForgeSteps {
    crate::rig::steps_in(home.path(), &TempStore::new(), Arc::new(FakeConfinement::new()))
}

#[tokio::test]
async fn a_forge_run_works_in_a_build_folder_whose_shell_runs_under_the_sandbox() {
    let home = TempHome::new();
    let folder = steps(&home).prepare_folder("rn-0a1b2c3d4e5f").await.expect("made").expect("a folder");
    assert_eq!(folder, build_folder(&home.join("scratch"), "rn-0a1b2c3d4e5f").to_string_lossy());
    let text = std::fs::read_to_string(home.join("scratch/forge-rn-0a1b2c3d4e5f/.claude/settings.json")).expect("read");
    let settings: serde_json::Value = serde_json::from_str(&text).expect("json");
    let sandbox = &settings["sandbox"];
    assert_eq!((sandbox["enabled"].as_bool(), sandbox["failIfUnavailable"].as_bool()), (Some(true), Some(true)));
    assert_eq!(sandbox["allowUnsandboxedCommands"], false, "no command may leave the sandbox");
    assert_eq!(sandbox["allowAppleEvents"], false);
    assert_eq!(sandbox["network"]["allowedDomains"], serde_json::json!(REGISTRY_HOSTS));
    // The home folder is closed but for the build folder and the toolchains (L9).
    let folder = home.join("scratch/forge-rn-0a1b2c3d4e5f").to_string_lossy().into_owned();
    let mut reads = vec![folder];
    reads.extend(eos_mod_forge::TOOLCHAIN_READS.map(str::to_owned));
    assert_eq!(sandbox["filesystem"], serde_json::json!({"denyRead": ["~"], "allowRead": reads}));
    assert!(!reads.iter().any(|read| read == "~/.cargo" || read.ends_with(".npmrc")), "no toolchain sign-in");
    let npm = std::fs::read_to_string(home.join("scratch/forge-rn-0a1b2c3d4e5f/.npmrc")).expect("npm's settings");
    assert!(npm.lines().any(|line| line == "ignore-scripts=true"), "npm runs no install script here");
    assert!(npm.lines().any(|line| line == "bin-links=false"), "npm makes no link Eos would refuse");
}

#[tokio::test]
async fn a_run_id_that_names_another_folder_is_refused() {
    let home = TempHome::new();
    for id in ["../../.ssh", "", "rn/1"] {
        assert!(steps(&home).prepare_folder(id).await.is_err(), "{id}");
    }
}

#[test]
fn the_forges_research_is_capped_at_ten_minutes_and_two_dollars() {
    let definitions = crate::rig::definitions();
    let blueprint = eos_mod_forge::blueprint(&definitions).expect("a blueprint");
    let research = &blueprint["project"]["milestones"][0];
    assert_eq!(research["key"], "research");
    assert_eq!(research["limits"], serde_json::json!({"usd": 2, "minutes": 10}));
    let blueprint: eos_contracts::Blueprint = serde_json::from_value(blueprint).expect("reads");
    let limits = blueprint.project.expect("a project").milestones[0].limits.expect("caps");
    assert_eq!((limits.usd, limits.minutes), (2.0, 10));
}
