//! A Forge builder's shell command, run through the engine in a build
//! folder that holds the Forge's sandbox settings (L9): it reads its build
//! folder, though that is inside the home folder, and the system, never the
//! rest of the home folder, and writes nowhere else. The engine's home is
//! the bench's. macOS only, and skipped, saying so, where the sandbox does
//! not work.

use eos_agent_mock_api::Reply;
use eos_domain::capability::forge_sandbox;
use serde_json::{Value, json};

use super::Bench;

/// Says what it could reach, run in the build folder.
const COMMAND: &str = "cat ../../../planted.txt 2>/dev/null || echo HOME-DENIED; \
                       cat inside.txt; ls /usr/bin >/dev/null && echo SYSTEM-READ; \
                       (echo x > ../outside.txt) 2>/dev/null && echo WROTE-OUTSIDE; true";

fn shell_results(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|e| e["role"] == "tool")
        .flat_map(|e| e["blocks"].as_array().cloned().unwrap_or_default())
        .filter(|b| b["type"] == "tool_result")
        .map(|b| b["content"].to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_builders_shell_reads_its_build_folder_but_not_the_rest_of_the_home_folder() {
    let input = json!({"command": COMMAND, "description": "What it can reach"}).to_string();
    let bench = Bench::new([Reply::tool_use("toolu_sh", "Bash", &input), Reply::text("done")]).await;
    let home = bench.dir.path().join("home").canonicalize().expect("the home");
    std::fs::write(home.join("planted.txt"), "PLANTED-IN-HOME\n").expect("a file");
    let build = home.join(".eos/scratch/forge-rn-1");
    std::fs::create_dir_all(build.join(".claude")).expect("a folder");
    std::fs::write(build.join(".claude/settings.json"), forge_sandbox::settings(&build)).expect("its settings");
    std::fs::write(build.join("inside.txt"), "BUILD-FILE\n").expect("a file");

    let spec = eos_core::agent::LaunchSpec {
        prompt: Some("build it".into()),
        ..eos_core::agent::LaunchSpec::new("w-builder", build.to_string_lossy(), "mock-model")
    };
    bench.start(spec).await;
    let events = bench.after_turns("w-builder", 1).await;
    let results = shell_results(&events);
    let result = results.first().map(String::as_str).unwrap_or_default();
    if result.contains("sandbox cannot start") {
        eprintln!("skipped: the sandbox does not work on this Mac");
        return;
    }
    assert!(!result.contains("PLANTED-IN-HOME") && result.contains("HOME-DENIED"), "the home stays closed: {result}");
    assert!(result.contains("BUILD-FILE"), "its build folder reads: {result}");
    assert!(result.contains("SYSTEM-READ"), "the system reads: {result}");
    assert!(!result.contains("WROTE-OUTSIDE"), "writes stay in the folder: {result}");
}
