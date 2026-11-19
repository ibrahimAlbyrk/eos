//! Chats: a scripted session that carries secrets in its messages, a page, requests with
//! secret queries and a library error that quotes them. The log tells the session's story
//! by id.

use std::time::Duration;

use eos_app::App;
use eos_runtime::http::Method;
use serde_json::json;

use crate::{Area, rig};

const MESSAGE: &str = "PLANTED-MESSAGE-zebra-quartz";
const EMAIL: &str = "planted.person@example.com";
const TOKEN: &str = "sk-ant-api03-PLANTEDTOKENa1b2c3d4e5f6g7h8i9j0";
const QUERY: &str = "PLANTEDQUERYvalue";
const PAGE: &str = "PLANTED-PAGE-body-walrus";

pub(crate) async fn steps(app: &App) -> Area {
    let project = tempfile::tempdir().expect("a project");
    std::fs::write(project.path().join("README.md"), "# project\n").expect("a file");
    let cwd = project.path().canonicalize().expect("the folder").to_string_lossy().into_owned();

    let chat = rig::focused_chat(app, &cwd, &format!("{MESSAGE} mail {EMAIL} key {TOKEN}")).await;
    let mut frames = rig::Frames::new(rig::open_stream(app, "topics=worker:*").await.expect("a stream"));
    let _ = frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await;
    for text in [format!("[tools] {MESSAGE}"), format!("[failing] {MESSAGE} {EMAIL}")] {
        let body = json!({"text": text, "clientMsgId": format!("c-{}", text.len()), "queueWhenBusy": true});
        let (status, answer) = rig::call(app, Method::Post, &format!("/workers/{chat}/message"), Some(body)).await;
        assert!(status < 300, "{answer}");
        let _ = frames.until(Duration::from_secs(20), |f| rig::went(f, &chat, "IDLE")).await;
    }
    let page = json!({"title": format!("{PAGE} {EMAIL}"), "body": format!("{PAGE} {TOKEN}")});
    let (status, _) = rig::call(app, Method::Post, "/api/pages", Some(page)).await;
    assert_eq!(status, 201);
    // A request with a secret query, refused and answered: only its route is ever logged.
    let target = format!("/api/pages?token={QUERY}&q={EMAIL}");
    let _ = rig::call(app, Method::Get, &target, None).await;
    let _ = rig::call(app, Method::Get, &format!("/fs/stat?path={QUERY}"), None).await;
    // A library's error text that quotes what it must not: the file's own scrubber cuts it.
    tracing::warn!(
        error = %format!("error sending request for url (https://api.example.com/v1/x?key={QUERY}) as {EMAIL} with Bearer {TOKEN}"),
        "a planted library error"
    );
    let (status, _) = rig::call(app, Method::Delete, &format!("/workers/{chat}"), None).await;
    assert!(status < 300);

    let story = ["database", "worker started", "turn started", "turn ended", "outcome=\"error\"", "worker removed"];
    let mut told: Vec<String> = story.into_iter().map(str::to_owned).collect();
    // The chat's id; the URL keeps its host and path.
    told.extend([chat, "https://api.example.com/v1/x?<query>".to_owned()]);
    Area { planted: [MESSAGE, EMAIL, TOKEN, QUERY, PAGE, "sk-ant-"].map(str::to_owned).to_vec(), told }
}
