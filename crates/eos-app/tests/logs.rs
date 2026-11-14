//! The core's log as the installed app writes it (`eos_kit_log`, every Eos crate at
//! debug), after a scripted session that carries secrets: it tells the session's story by
//! id, and none of the planted secrets reaches the file (`ARCHITECTURE.md`, "What may be
//! logged").

#[path = "support/rig.rs"]
mod rig;

use std::time::Duration;

use eos_kit_log::Scrubber;
use eos_runtime::http::Method;
use eos_testkit::{ScriptedRuntime, TempHome};
use serde_json::json;

const MESSAGE: &str = "PLANTED-MESSAGE-zebra-quartz";
const EMAIL: &str = "planted.person@example.com";
const TOKEN: &str = "sk-ant-api03-PLANTEDTOKENa1b2c3d4e5f6g7h8i9j0";
const QUERY: &str = "PLANTEDQUERYvalue";
const PAGE: &str = "PLANTED-PAGE-body-walrus";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_scripted_session_is_told_by_id_and_nothing_private_reaches_the_log() {
    let logs = tempfile::tempdir().expect("a folder");
    let user_home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    assert!(eos_kit_log::init_with(Some("warn,eos=debug,eos_agent=warn"), false), "the only subscriber of this test binary");
    eos_kit_log::catch_panics();
    eos_kit_log::attach(logs.path(), Scrubber::new(user_home.as_deref()));

    let home = TempHome::new();
    let project = tempfile::tempdir().expect("a project");
    std::fs::write(project.path().join("README.md"), "# project\n").expect("a file");
    let cwd = project.path().canonicalize().expect("the folder").to_string_lossy().into_owned();
    let agents = ScriptedRuntime::new();
    agents.otherwise(rig::turn_for);
    let app = rig::build(home.path(), &agents);
    app.start().await.expect("starts");

    let chat = rig::focused_chat(&app, &cwd, &format!("{MESSAGE} mail {EMAIL} key {TOKEN}")).await;
    let mut frames = rig::Frames::new(rig::open_stream(&app, "topics=worker:*").await.expect("a stream"));
    let _ = frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await;
    for text in [format!("[tools] {MESSAGE}"), format!("[failing] {MESSAGE} {EMAIL}")] {
        let body = json!({"text": text, "clientMsgId": format!("c-{}", text.len()), "queueWhenBusy": true});
        let (status, answer) = rig::call(&app, Method::Post, &format!("/workers/{chat}/message"), Some(body)).await;
        assert!(status < 300, "{answer}");
        let _ = frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await;
    }
    let page = json!({"title": format!("{PAGE} {EMAIL}"), "body": format!("{PAGE} {TOKEN}")});
    let (status, _) = rig::call(&app, Method::Post, "/api/pages", Some(page)).await;
    assert_eq!(status, 201);
    // A request with a secret query, refused and answered: only its route is ever logged.
    let target = format!("/api/pages?token={QUERY}&q={EMAIL}");
    let _ = rig::call(&app, Method::Get, &target, None).await;
    let _ = rig::call(&app, Method::Get, &format!("/fs/stat?path={QUERY}"), None).await;
    // A library's error text that quotes what it must not: the file's own scrubber cuts it.
    tracing::warn!(
        error = %format!("error sending request for url (https://api.example.com/v1/x?key={QUERY}) as {EMAIL} with Bearer {TOKEN}"),
        "a planted library error"
    );
    let (status, _) = rig::call(&app, Method::Delete, &format!("/workers/{chat}"), None).await;
    assert!(status < 300);
    app.shutdown(Duration::from_secs(5)).await;
    assert!(eos_kit_log::flush(Duration::from_secs(5)));

    let mut text = String::new();
    for entry in std::fs::read_dir(logs.path()).expect("the logs folder") {
        text.push_str(&std::fs::read_to_string(entry.expect("an entry").path()).expect("reads"));
    }
    for planted in [MESSAGE, EMAIL, TOKEN, QUERY, PAGE, "sk-ant-"] {
        assert!(!text.contains(planted), "{planted} reached the log:\n{}", lines_with(&text, planted));
    }
    if let Some(user) = user_home.as_deref().and_then(|h| h.to_str()).filter(|h| h.len() > 1) {
        assert!(!text.contains(user), "the home folder is written as ~");
    }

    // The story, by id.
    for told in ["database", "worker started", "turn started", "turn ended", "outcome=\"error\"", "worker removed"] {
        assert!(text.contains(told), "the log tells {told:?}:\n{text}");
    }
    assert!(text.contains(&chat), "the chat's id is in the log");
    assert!(text.contains("https://api.example.com/v1/x?<query>"), "the URL keeps its host and path");
    if std::env::var_os("EOS_LOG_TEST_SHOW").is_some() {
        println!("{text}");
    }
}

fn lines_with<'a>(text: &'a str, needle: &str) -> String {
    text.lines().filter(|l| l.contains(needle)).collect::<Vec<&'a str>>().join("\n")
}
