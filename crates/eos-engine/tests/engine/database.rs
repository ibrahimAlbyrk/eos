//! The agents' file tools run in the app's process: none may open the
//! database's files, or the app loses SQLite's locks and dies when another
//! program opens the database next.

use eos_agent_mock_api::Reply;
use eos_testkit::BusyDatabase;
use serde_json::{Value, json};

use super::Bench;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_file_tool_opens_the_database_and_the_app_keeps_its_locks() {
    let dir = tempfile::tempdir().expect("a folder");
    let data = dir.path().canonicalize().expect("the data folder");
    let busy = BusyDatabase::open(&data);
    eos_platform::DataPaths::new(&data).ignore_database_files().expect("the .ignore");
    std::fs::write(data.join("notes.txt"), "a needle in the data folder").expect("a note");
    let file = |name: &str| data.join(name).to_string_lossy().into_owned();
    let root = data.to_string_lossy().into_owned();
    let calls = [
        ("Read", json!({"file_path": file("state.db-shm")})),
        ("Read", json!({"file_path": file("state.db")})),
        ("Read", json!({"file_path": "../state.db-wal"})),
        ("Read", json!({"file_path": file("project/../State.DB-shm")})),
        ("Grep", json!({"pattern": "needle", "path": file("state.db-shm")})),
        ("Grep", json!({"pattern": "needle", "path": root, "glob": "*"})),
        // Walks the data folder: its .ignore keeps the database's files out.
        ("Grep", json!({"pattern": "needle", "path": root, "output_mode": "files_with_matches"})),
    ];
    let mut replies: Vec<Reply> = calls
        .iter()
        .enumerate()
        .map(|(i, (tool, input))| Reply::tool_use(&format!("t{i}"), tool, &input.to_string()))
        .collect();
    replies.push(Reply::text("done"));
    let bench = Bench::in_dir(dir, replies).await;
    let session = bench.start(bench.spec("w-1")).await;
    session.send("go".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;

    let results: Vec<&Value> = events.iter().filter(|e| e["role"] == "tool").map(|e| &e["blocks"][0]).collect();
    assert_eq!(results.len(), calls.len());
    for (i, result) in results[..6].iter().enumerate() {
        let said = result["content"].as_str().unwrap_or_default();
        assert_eq!(result["isError"], true, "call {i}: {said}");
        assert!(said.contains("Eos's database files"), "call {i}: {said}");
    }
    for result in &results[6..] {
        let said = result["content"].as_str().unwrap_or_default();
        assert!(said.contains("notes.txt") && !said.contains("state.db"), "{said}");
    }
    let asked: Vec<String> = bench.policy.asked.lock().expect("asked").iter().map(|c| c.tool_name.clone()).collect();
    assert_eq!(asked, ["Grep"], "a refused call never reaches the policy");

    busy.another_program_opens();
    busy.finish();
}

/// A rewrite rule or the user editing an ask can change a call's input after
/// the gate looked at it: the input that would run is checked again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_input_the_policy_rewrote_to_a_database_file_is_refused() {
    let dir = tempfile::tempdir().expect("a folder");
    let data = dir.path().canonicalize().expect("the data folder");
    let busy = BusyDatabase::open(&data);
    std::fs::write(data.join("notes.txt"), "a note").expect("a note");
    let asked = json!({"file_path": data.join("notes.txt")}).to_string();
    let bench = Bench::in_dir(dir, [Reply::tool_use("t1", "Read", &asked), Reply::text("done")]).await;
    let shm = json!({"file_path": data.join("state.db-shm")});
    let shm = serde_json::from_value(shm).expect("a record");
    bench.policy.rewrite.lock().expect("rewrite").push(("Read".into(), shm));
    let session = bench.start(bench.spec("w-1")).await;
    session.send("go".into()).await.expect("sends");
    let events = bench.after_turns("w-1", 1).await;

    let result = events.iter().find(|e| e["role"] == "tool").map(|e| &e["blocks"][0]).expect("the Read's result");
    let said = result["content"].as_str().unwrap_or_default();
    assert_eq!(result["isError"], true, "{said}");
    assert!(said.contains("Eos's database files"), "{said}");

    busy.another_program_opens();
    busy.finish();
}
