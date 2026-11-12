//! The folder sync domain (`manager/services/__tests__/user-sync-domains.test.ts`,
//! "a folder domain carries files and assets, refuses unsafe names, deletes softly").

#![allow(clippy::unwrap_used)]

use std::fs;
use std::sync::Arc;

use eos_core::net::sync::SyncDomain;
use eos_store_files::sync_dir::FileDirDomain;
use eos_testkit::FakeClock;
use serde_json::json;

#[tokio::test]
async fn a_folder_domain_carries_files_and_assets_refuses_unsafe_names_deletes_softly() {
    let (src, dst) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    fs::create_dir_all(src.path().join("assets/review")).unwrap();
    fs::write(src.path().join("review.md"), "---\ndescription: d\n---\n\nbody\n").unwrap();
    fs::write(src.path().join("assets/review/shot.png"), [1, 2, 3]).unwrap();
    fs::write(src.path().join("assets/review/.DS_Store"), "x").unwrap();
    fs::write(src.path().join("notes.txt"), "ignored").unwrap();
    fs::write(src.path().join("Not-A-Name.md"), "ignored: not a template name").unwrap();
    let clock = Arc::new(FakeClock::new());
    let a = FileDirDomain::templates(src.path(), clock.clone());
    let b = FileDirDomain::templates(dst.path(), clock.clone());

    let items = a.list().await.unwrap();
    assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["review"]);
    // The record as the TypeScript app writes it: the file's text, attached files in base64.
    assert_eq!(items[0].data, json!({ "md": "---\ndescription: d\n---\n\nbody\n", "assets": { "shot.png": "AQID" } }));
    assert!(items[0].updated_at.is_some_and(|at| at > 1.7e12), "the file's own time, in milliseconds");

    b.apply("review", &items[0].data).await.unwrap();
    assert_eq!(fs::read_to_string(dst.path().join("review.md")).unwrap(), "---\ndescription: d\n---\n\nbody\n");
    assert_eq!(fs::read(dst.path().join("assets/review/shot.png")).unwrap(), [1, 2, 3]);
    assert_eq!(b.get("review").await.unwrap().unwrap().data, items[0].data, "what was applied reads back the same");

    // A later version without the attachment takes it away here too.
    fs::write(dst.path().join("assets/review/old.png"), [9]).unwrap();
    b.apply("review", &json!({ "md": "v2", "assets": { "shot.png": "AQID" } })).await.unwrap();
    assert!(!dst.path().join("assets/review/old.png").exists());
    assert_eq!(fs::read_to_string(dst.path().join("review.md")).unwrap(), "v2");

    assert!(b.apply("../escape", &json!({ "md": "x" })).await.is_err());
    assert!(b.apply("ok", &json!({ "md": "x", "assets": { "../x": "AA==" } })).await.is_err());
    assert!(b.apply("ok", &json!({ "assets": {} })).await.is_err());
    assert!(!dst.path().join("ok.md").exists(), "a refused record writes nothing");
    assert!(b.get("../review").await.unwrap().is_none());

    b.remove("review").await.unwrap();
    assert!(!dst.path().join("review.md").exists());
    let trashed: Vec<String> = fs::read_dir(dst.path().join(".trash"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(trashed.iter().any(|name| name.starts_with("review.")));
    assert!(dst.path().join(".trash/assets").join(format!("review.{}", FakeClock::START_MS)).is_dir());
    assert!(b.remove("../escape").await.is_err());
}

#[tokio::test]
async fn worker_definitions_travel_without_attachments() {
    let (src, dst) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let clock = Arc::new(FakeClock::new());
    let a = FileDirDomain::workers(src.path().join("workers"), clock.clone());
    assert!(a.list().await.unwrap().is_empty(), "a folder that is not there yet is empty");
    fs::create_dir_all(src.path().join("workers/assets/reviewer")).unwrap();
    fs::write(src.path().join("workers/reviewer.md"), "---\nname: reviewer\n---\nReview.\n").unwrap();
    fs::write(src.path().join("workers/assets/reviewer/x.png"), [1]).unwrap();
    let item = a.get("reviewer").await.unwrap().unwrap();
    assert_eq!(item.data, json!({ "md": "---\nname: reviewer\n---\nReview.\n" }));
    let b = FileDirDomain::workers(dst.path().join("workers"), clock);
    b.apply("reviewer", &item.data).await.unwrap();
    assert_eq!(
        fs::read_to_string(dst.path().join("workers/reviewer.md")).unwrap(),
        "---\nname: reviewer\n---\nReview.\n"
    );
}
