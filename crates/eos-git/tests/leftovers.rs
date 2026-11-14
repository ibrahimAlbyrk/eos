//! What Eos deletes on its own, on throwaway repositories only: the worktrees and
//! scratch folders of workers that are gone — and never the folders of a chat that
//! exists in the data.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_contracts::NameSource;
use eos_core::agent::ScratchFolders;
use eos_core::store::{NewWorker, Store};
use eos_git::ScratchRepos;
use eos_sessions::cleanup::{prune_orphan_scratch, prune_orphan_worktrees};
use eos_testkit::TempStore;
use support::{Dir, adapter, commit_file, git_ok, init_repo};

fn add_worktree(repo: &Dir, at: &str, branch: &str) -> PathBuf {
    let dir = repo.join(at);
    fs::create_dir_all(dir.parent().expect("parent")).expect("dirs");
    git_ok(&repo.path, &["worktree", "add", "-q", dir.to_str().expect("utf-8"), "-b", branch]);
    fs::canonicalize(dir).expect("real path")
}

fn row(id: &str, cwd: Option<&str>, repo: Option<&Path>, branch: Option<&str>) -> NewWorker {
    NewWorker {
        id: id.into(),
        prompt: String::new(),
        cwd: cwd.map(str::to_owned),
        worktree_from: repo.map(|r| r.to_string_lossy().into_owned()),
        branch: branch.map(str::to_owned),
        name: None,
        name_source: NameSource::Default,
        pid: None,
        port: 0,
        started_at: 1,
        parent_id: None,
        model: "opus".into(),
        effort: None,
        is_orchestrator: false,
        backend_kind: "claude".into(),
        backend_profile: None,
        agent_role: None,
        worker_definition: None,
        tool_scope: None,
        with_gateway: false,
        collaborate: false,
        worktree_dir: None,
        workspace_owner_id: None,
        workspace_ready: true,
        scratch: cwd.is_some(),
    }
}

async fn insert(store: &Arc<dyn Store>, worker: NewWorker, archived: bool) {
    store
        .write(move |tx, _| {
            tx.workers().insert(&worker)?;
            if archived {
                tx.workers().set_archived(&worker.id, Some(2))?;
            }
            Ok(())
        })
        .await
        .expect("inserts");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_that_exists_keeps_its_worktree_and_only_eos_own_orphans_go() {
    let repo = init_repo("eos-prune-");
    commit_file(&repo.path, "README.md", "hi\n", "init");
    let live = add_worktree(&repo, ".eos/worktrees/eos-live-1", "eos-live-1");
    let archived = add_worktree(&repo, ".eos/worktrees/eos-archived-2", "eos-archived-2");
    let orphan = add_worktree(&repo, ".eos/worktrees/eos-orphan-3", "eos-orphan-3");
    let locked = add_worktree(&repo, ".eos/worktrees/eos-locked-4", "eos-locked-4");
    git_ok(&repo.path, &["worktree", "lock", locked.to_str().expect("utf-8")]);
    let users_own = add_worktree(&repo, ".eos/worktrees/feature", "feature");
    let elsewhere = add_worktree(&repo, "side/eos-elsewhere-5", "eos-elsewhere-5");
    fs::write(live.join("work.txt"), "uncommitted work of a running chat").expect("a file");
    fs::write(archived.join("work.txt"), "uncommitted work of an archived chat").expect("a file");

    let temp = TempStore::new();
    let store: Arc<dyn Store> = temp.port();
    insert(&store, row("w-live", None, Some(&repo.path), Some("eos-live-1")), false).await;
    insert(&store, row("w-archived", None, Some(&repo.path), Some("eos-archived-2")), true).await;

    let pruned = prune_orphan_worktrees(store.as_ref(), &adapter()).await.expect("prunes");
    assert_eq!(pruned, std::slice::from_ref(&orphan));
    assert!(!orphan.exists(), "the worktree of a worker that is gone is deleted");
    for kept in [&live, &archived, &locked, &users_own, &elsewhere] {
        assert!(kept.exists(), "{} must stay", kept.display());
    }
    assert!(live.join("work.txt").exists() && archived.join("work.txt").exists());
    let branches = git_ok(&repo.path, &["branch", "--list"]);
    assert!(!branches.contains("eos-orphan-3"), "{branches}");
    assert!(branches.contains("eos-live-1") && branches.contains("eos-archived-2"), "{branches}");

    // A worktree worker with no branch on its row: nothing in its repository can be told from its worktree.
    let again = add_worktree(&repo, ".eos/worktrees/eos-orphan-6", "eos-orphan-6");
    insert(&store, row("w-old", None, Some(&repo.path), None), false).await;
    assert!(prune_orphan_worktrees(store.as_ref(), &adapter()).await.expect("prunes").is_empty());
    assert!(again.exists());

    // A repository no worker names is never looked at.
    let other = init_repo("eos-prune-other-");
    commit_file(&other.path, "README.md", "hi\n", "init");
    let stray = add_worktree(&other, ".eos/worktrees/eos-stray-7", "eos-stray-7");
    prune_orphan_worktrees(store.as_ref(), &adapter()).await.expect("prunes");
    assert!(stray.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scratch_folder_is_a_repository_and_goes_with_what_claude_code_kept_about_it() {
    let home = Dir::new("eos-scratch-");
    let (root, projects) = (home.join("scratch"), home.join("claude/projects"));
    let scratch = ScratchRepos::new(adapter(), &root, &projects);

    let dir = scratch.create("w-1").await.expect("creates");
    assert_eq!(Path::new(&dir), root.join("w-1"));
    assert_eq!(git_ok(Path::new(&dir), &["log", "--format=%s"]).trim(), "Eos scratch folder");
    let archived = scratch.create("w-2").await.expect("creates");
    let orphan = scratch.create("w-3").await.expect("creates");
    let encoded: String =
        orphan.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect();
    for name in [encoded.clone(), format!("{encoded}--eos-worktrees-eos-sub-1"), format!("{encoded}x")] {
        fs::create_dir_all(projects.join(name)).expect("a folder");
    }

    let temp = TempStore::new();
    let store: Arc<dyn Store> = temp.port();
    insert(&store, row("w-1", Some(&dir), None, None), false).await;
    insert(&store, row("w-2", Some(&archived), None, None), true).await;
    let pruned = prune_orphan_scratch(store.as_ref(), &scratch).await.expect("prunes");
    assert_eq!(pruned, std::slice::from_ref(&orphan));
    let mut left = scratch.list();
    left.sort();
    assert_eq!(left, [dir.clone(), archived], "an archived chat still owns its folder");
    let mut kept: Vec<_> = fs::read_dir(&projects)
        .expect("lists")
        .flatten()
        .map(|e| e.file_name().into_string().expect("utf-8"))
        .collect();
    kept.sort();
    assert_eq!(kept, [format!("{encoded}x")], "its own data and its sub-agents' go; a neighbour's stays");

    // Only a folder directly under the scratch root is ever deleted.
    let outside = home.join("precious");
    fs::create_dir_all(&outside).expect("a folder");
    scratch.remove(outside.to_str().expect("utf-8")).await;
    scratch.remove(home.path.to_str().expect("utf-8")).await;
    assert!(outside.exists() && Path::new(&dir).exists());
}
