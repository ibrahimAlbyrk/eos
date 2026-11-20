//! Folders and branches on this computer: a file counts once it held still,
//! hidden and partial files never; a listing after Eos was closed finds
//! what changed; a branch's new commits are one signal, a force-push says
//! so; a folder that cannot be read says why.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use eos_contracts::{Fact, Facts, RoutineKind, RoutineState};
use eos_core::routine::RoutineTriggers;
use eos_core::store::{StoredSignal, StoredSignalSource};
use eos_mod_signals::{FOLDER_LISTING_MS, FOLDER_SETTLE_MS, SignalsModule};
use eos_runtime::module::Module;
use eos_testkit::TempHome;
use serde_json::{Value, json};

use crate::rig::{Bench, SavedIntake};

fn watching(id: &str, on: Value) -> RoutineTriggers {
    RoutineTriggers {
        id: id.into(),
        version: format!("rv-{id}"),
        state: RoutineState::Active,
        kind: RoutineKind::Standing,
        when: serde_json::from_value(json!({ "on": [on] })).expect("a When"),
        which: serde_json::from_value(json!({})).expect("a Which"),
    }
}

fn pdfs(dir: &Path) -> RoutineTriggers {
    let folder = json!({ "path": dir, "names": "*.pdf", "events": ["added", "changed", "removed"] });
    watching("rt-f", json!({ "folder": folder }))
}

/// The row of the local source of `kind`.
fn row(bench: &Bench, kind: &'static str) -> Option<StoredSignalSource> {
    let rows = bench.temp.store.read_blocking(|tx| tx.signal_sources().all()).expect("reads");
    rows.into_iter().find(|row| row.kind == kind)
}

/// Every signal of the local sources, oldest first.
fn signals(bench: &Bench) -> Vec<StoredSignal> {
    let mut found = Vec::new();
    for id in 1..100 {
        let Some(signal) = bench.temp.store.read_blocking(move |tx| tx.signals().find(id)).expect("reads") else {
            break;
        };
        found.push(signal);
    }
    found
}

fn facts(signal: &StoredSignal) -> Facts {
    serde_json::from_str(signal.signal.facts_json.as_deref().unwrap_or("{}")).expect("facts")
}

fn text(facts: &Facts, name: &str) -> String {
    match facts.get(name) {
        Some(Fact::Text(text)) => text.clone(),
        other => panic!("{name}: {other:?}"),
    }
}

fn publish(bench: &Bench, topic: &'static str, payload: Value) {
    bench.bus.publish_raw(topic, None, payload.to_string().into_bytes().into());
}

fn file_changed(bench: &Bench, dir: &Path) {
    let change = json!({ "kind": "add", "path": dir.join("x"), "dir": dir, "ts": 1 });
    publish(bench, "fs:change", json!({ "changes": [change] }));
}

async fn started(bench: &Bench, kind: &'static str) -> SignalsModule {
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.after_ready().await.expect("ready");
    bench.until(|| row(bench, kind).is_some_and(|row| row.last_poll_at.is_some())).await;
    module
}

/// Waits until a pass found a file that has not settled yet.
async fn settling(bench: &Bench) {
    bench.until(|| bench.sleeper.pending().contains(&FOLDER_SETTLE_MS)).await;
}

/// Moves past the settling time and starts a pass.
fn settle(bench: &Bench) {
    bench.clock.set(eos_core::Clock::now_ms(bench.clock.as_ref()) + FOLDER_SETTLE_MS);
    publish(bench, "routine:change", json!({}));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_counts_once_it_held_still_and_hidden_or_partial_files_never() {
    let folder = TempHome::new();
    folder.write("old.pdf", "there before");
    let bench = Bench::new(vec![pdfs(folder.path())]);
    let module = started(&bench, "folder").await;
    assert!(signals(&bench).is_empty(), "what is there already starts nothing");
    assert_eq!(bench.watcher.leases(folder.path()), 1);

    folder.write("a.pdf", "half");
    folder.write(".hidden.pdf", "x");
    folder.write("b.pdf.part", "x");
    folder.write("c.txt", "x");
    file_changed(&bench, folder.path());
    settling(&bench).await;
    assert!(signals(&bench).is_empty(), "nothing counts before it held still");

    settle(&bench);
    bench.until(|| signals(&bench).len() == 2).await;
    bench.route(&module).await;
    let found = signals(&bench);
    let names: Vec<(String, String)> =
        found.iter().map(|signal| (text(&facts(signal), "name"), signal.signal.kind.clone())).collect();
    assert_eq!(names, [("a.pdf".into(), "added".into()), ("c.txt".into(), "added".into())]);
    let a = &found[0];
    assert!(a.signal.key.starts_with(&format!("file:{}@4-", folder.join("a.pdf").display())));
    let routes = bench.routes();
    assert_eq!(routes.len(), 1, "only the name the routine reads: {routes:?}");
    assert_eq!((routes[0].0, routes[0].2.as_str()), (a.id, "run"));
    module.stop().await;
    assert_eq!(bench.watcher.leases(folder.path()), 0, "the watch is given back");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_listing_after_a_closed_period_finds_what_changed() {
    let folder = TempHome::new();
    folder.write("kept.pdf", "one");
    folder.write("gone.pdf", "two");
    let bench = Bench::new(vec![pdfs(folder.path())]);
    started(&bench, "folder").await.stop().await;

    std::fs::remove_file(folder.join("gone.pdf")).expect("removed");
    folder.write("kept.pdf", "one, longer");
    folder.write("new.pdf", "three");
    bench.clock.set(eos_core::Clock::now_ms(bench.clock.as_ref()) + FOLDER_LISTING_MS);
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.after_ready().await.expect("ready");
    bench.until(|| signals(&bench).len() == 1).await;
    settling(&bench).await;
    settle(&bench);
    bench.until(|| signals(&bench).len() == 3).await;
    let mut seen: Vec<(String, String)> =
        signals(&bench).iter().map(|signal| (text(&facts(signal), "name"), signal.signal.kind.clone())).collect();
    seen.sort();
    assert_eq!(
        seen,
        [
            ("gone.pdf".into(), "removed".into()),
            ("kept.pdf".into(), "changed".into()),
            ("new.pdf".into(), "added".into())
        ]
    );
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_that_is_missing_or_inside_the_data_folder_says_why() {
    let link = std::env::temp_dir().join(format!("eos-data-link-{}", std::process::id()));
    for spelling in ["pages", "parent", "link", "case"] {
        let bench = Bench::new(Vec::new());
        let home = bench.home.path().to_owned();
        std::fs::create_dir_all(home.join("pages")).expect("a folder");
        let inside = match spelling {
            "pages" => home.join("pages"),
            "parent" => home.join("..").join(home.file_name().expect("a name")).join("pages"),
            "link" => {
                let _ = std::fs::remove_file(&link);
                std::os::unix::fs::symlink(&home, &link).expect("a link");
                link.join("pages")
            }
            _ => {
                let upper = PathBuf::from(home.join("pages").to_string_lossy().to_uppercase());
                if !upper.exists() {
                    continue; // a disk that tells letter case apart
                }
                upper
            }
        };
        bench.directory.set(vec![pdfs(&inside)]);
        let module = started(&bench, "folder").await;
        let row = row(&bench, "folder").expect("the row");
        assert_eq!(
            (row.state.as_str(), row.error_kind.as_deref()),
            ("needs-attention", Some("inside-data")),
            "{spelling}"
        );
        assert_eq!(bench.watcher.leases(&inside), 0, "never watched");
        module.stop().await;
    }
    let _ = std::fs::remove_file(&link);
    let missing = std::env::temp_dir().join("eos-no-such-folder-0a1b2c");

    let bench = Bench::new(vec![pdfs(&missing)]);
    let module = started(&bench, "folder").await;
    let row = self::row(&bench, "folder").expect("the row");
    assert_eq!((row.state.as_str(), row.error_kind.as_deref()), ("needs-attention", Some("missing")));
    module.stop().await;
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn commit(repo: &Path, author: &str, name: &str) {
    std::fs::write(repo.join(name), author).expect("a file");
    git(repo, &["add", "-A"]);
    git(repo, &["-c", &format!("user.name={author}"), "commit", "-q", "-m", name]);
}

fn moved(bench: &Bench, repo: &Path) {
    publish(bench, "git:change", json!({ "dir": repo, "kinds": ["refs"], "ts": 1 }));
}

#[tokio::test(flavor = "multi_thread")]
async fn new_commits_on_a_branch_are_one_signal_and_a_force_push_says_so() {
    let home = TempHome::new();
    let repo = std::fs::canonicalize(home.path()).expect("its real path");
    git(&repo, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.email", "t@t.t"), ("user.name", "tester"), ("commit.gpgsign", "false")] {
        git(&repo, &["config", key, value]);
    }
    commit(&repo, "ann", "a.txt");
    let first = git(&repo, &["rev-parse", "HEAD"]);
    let routine = watching("rt-g", json!({ "git": { "repo": repo, "branch": "main" } }));
    let bench = Bench::new(vec![routine]);
    let module = started(&bench, "git").await;
    assert!(signals(&bench).is_empty(), "the first tip only starts the cursor");
    assert_eq!(bench.watcher.leases(&repo), 1);

    commit(&repo, "bob", "b.txt");
    commit(&repo, "cem", "c.txt");
    let tip = git(&repo, &["rev-parse", "HEAD"]);
    moved(&bench, &repo);
    bench.until(|| signals(&bench).len() == 1).await;
    let range = &signals(&bench)[0];
    assert_eq!(range.signal.key, format!("git:{}:main@{tip}", repo.display()));
    let given = facts(range);
    assert_eq!(given.get("count"), Some(&Fact::Number(2.into())));
    assert_eq!(given.get("authors"), Some(&Fact::List(vec!["cem".into(), "bob".into()])));
    assert_eq!(given.get("paths"), Some(&Fact::List(vec!["c.txt".into(), "b.txt".into()])));
    assert_eq!(given.get("rewritten"), Some(&Fact::Bool(false)));
    bench.route(&module).await;
    assert_eq!(bench.decided("run"), 1);

    git(&repo, &["reset", "-q", "--hard", &first]);
    commit(&repo, "dan", "d.txt");
    moved(&bench, &repo);
    bench.until(|| signals(&bench).len() == 2).await;
    let rewrite = facts(&signals(&bench)[1]);
    assert_eq!(rewrite.get("rewritten"), Some(&Fact::Bool(true)));
    assert_eq!(rewrite.get("authors"), Some(&Fact::List(vec!["dan".into()])));
    module.stop().await;
}
