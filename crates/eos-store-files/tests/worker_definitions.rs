//! Definition files end to end against today's TypeScript reader
//! (`fixtures/workers/vectors.json`): the same three folders, the same
//! records, in the same order, for each working folder.

use std::collections::BTreeMap;
use std::path::PathBuf;

use eos_contracts::WorkerDefinitionRecord;
use eos_core::store::WorkerDefinitionFiles;
use eos_store_files::worker_definitions::{BUILTIN_DEFINITIONS, FsWorkerDefinitionFiles, find_project_dir};
use eos_testkit::TempHome;
use eos_workers::definition::records_from;
use serde::Deserialize;

#[derive(Deserialize)]
struct Files {
    builtin: BTreeMap<String, String>,
    user: BTreeMap<String, String>,
    project: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Listing {
    cwd: Option<String>,
    records: Vec<WorkerDefinitionRecord>,
}

#[derive(Deserialize)]
struct Each {
    file: String,
    text: String,
    record: Option<WorkerDefinitionRecord>,
}

#[derive(Deserialize)]
struct Vectors {
    files: Files,
    listings: Vec<Listing>,
    each: Vec<Each>,
}

fn vectors() -> Vectors {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/workers/vectors.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).expect("the vectors")).expect("the vectors")
}

#[test]
fn the_shipped_definitions_are_the_typescript_trees() {
    let v = vectors();
    let shipped: BTreeMap<String, String> =
        BUILTIN_DEFINITIONS.iter().map(|(name, text)| ((*name).to_owned(), (*text).to_owned())).collect();
    assert_eq!(shipped, v.files.builtin);
}

#[test]
fn folders_list_as_typescript_lists_them() {
    let v = vectors();
    let root = TempHome::new();
    for (rel, text) in &v.files.user {
        root.write(format!("home/workers/{rel}"), text);
    }
    for (rel, text) in &v.files.project {
        root.write(format!("repo/.eos/workers/{rel}"), text);
    }
    std::fs::create_dir_all(root.join("repo/packages/app")).expect("a folder");
    std::fs::create_dir_all(root.join("elsewhere")).expect("a folder");

    let files = FsWorkerDefinitionFiles::new(root.join("home/workers"));
    for listing in &v.listings {
        let cwd = listing.cwd.as_ref().map(|cwd| root.join(cwd));
        let ours = records_from(&files.list(cwd.as_deref()));
        let names = |records: &[WorkerDefinitionRecord]| -> Vec<String> {
            records.iter().map(|r| format!("{} ({:?})", r.name, r.source)).collect()
        };
        assert_eq!(names(&ours), names(&listing.records), "in {:?}", listing.cwd);
        assert_eq!(ours, listing.records, "in {:?}", listing.cwd);
    }
    assert_eq!(find_project_dir(&root.join("repo/packages/app")), Some(root.join("repo/.eos/workers")));
}

#[test]
fn each_file_parses_as_typescript_parses_it() {
    for case in vectors().each {
        let root = TempHome::new();
        root.write("workers/x.md", &case.text);
        let listed = FsWorkerDefinitionFiles::new(root.join("workers")).list(None);
        let ours = records_from(&listed).into_iter().find(|r| r.source == eos_contracts::WorkerDefinitionSource::User);
        assert_eq!(ours, case.record, "{}", case.file);
    }
}
