use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use eos_core::BoxFuture;
use eos_core::git::{WorktreeCreate, WorktreeCreated, WorktreeEntry, WorktreeManager, WorktreeRef, WorktreeRemoved};
use eos_kit_fs::path::normalize;

use crate::Git;
use crate::hydrate::hydrate_worktree;
use crate::run::{Limits, parse_int};

/// Git knows a repository by its real path (and `/tmp` is a link on macOS),
/// while callers may hold the path as the user typed it.
fn real_path_or(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}

fn managed_dir(root: &Path, branch: &str) -> PathBuf {
    root.join(".eos").join("worktrees").join(branch)
}

/// Only folders under a `.eos/worktrees/` are ever removed by hand.
fn is_managed_dir(dir: &Path) -> bool {
    let mut parts = dir.components().map(|c| c.as_os_str());
    while let Some(part) = parts.next() {
        if part == ".eos"
            && parts.clone().next().is_some_and(|next| next == "worktrees")
            && parts.clone().nth(1).is_some()
        {
            return true;
        }
    }
    false
}

/// The number in base 36, as JavaScript's `n.toString(36)`.
fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_worktree_list(out: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    for line in out.split('\n') {
        if let Some(path) = line.strip_prefix("worktree ") {
            let is_main = entries.is_empty();
            entries.push(WorktreeEntry {
                path: normalize(Path::new(path.trim())),
                branch: None,
                locked: false,
                is_main,
            });
            continue;
        }
        let Some(current) = entries.last_mut() else { continue };
        if let Some(branch) = line.strip_prefix("branch ") {
            let branch = branch.trim();
            current.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_owned());
        } else if line == "locked" || line.starts_with("locked ") {
            current.locked = true;
        } else if line == "bare" {
            current.is_main = true;
        }
    }
    entries
}

impl Git {
    fn now_base36(&self) -> String {
        base36(u64::try_from(self.clock.now_ms()).unwrap_or(0))
    }

    async fn ok(&self, cwd: &Path, args: &[&str]) -> bool {
        self.run(cwd, args).await.is_ok()
    }

    /// Commits the source's uncommitted state (tracked and untracked) to a
    /// throwaway commit a worktree can fork from. `None` when the tree is
    /// clean or anything goes wrong: the worktree then forks from HEAD.
    async fn snapshot_dirty_state(&self, root: &Path) -> Option<String> {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        self.line(root, &["status", "--porcelain"]).await?;
        let index = std::env::temp_dir().join(format!(
            "eos-carry-{}-{}-{}",
            std::process::id(),
            self.now_base36(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let index_text = index.to_string_lossy().into_owned();
        let with_index = [("GIT_INDEX_FILE", index_text.as_str())];
        let commit = async {
            self.run_with(root, &["read-tree", "HEAD"], &with_index, Limits::default()).await.ok()?;
            self.run_with(root, &["add", "-A"], &with_index, Limits::default()).await.ok()?;
            let tree = self.run_with(root, &["write-tree"], &with_index, Limits::default()).await.ok()?.text();
            let (tree, head) = (tree.trim().to_owned(), self.line(root, &["rev-parse", "HEAD"]).await?);
            if tree.is_empty() {
                return None;
            }
            // A fixed identity: the repository may have no user.name.
            let identity = [
                ("GIT_INDEX_FILE", index_text.as_str()),
                ("GIT_AUTHOR_NAME", "eos"),
                ("GIT_AUTHOR_EMAIL", "eos@local"),
                ("GIT_COMMITTER_NAME", "eos"),
                ("GIT_COMMITTER_EMAIL", "eos@local"),
            ];
            let args = ["commit-tree", &tree, "-p", &head, "-m", "eos: carry uncommitted changes"];
            let made = self.run_with(root, &args, &identity, Limits::default()).await.ok()?.text();
            Some(made.trim().to_owned()).filter(|sha| !sha.is_empty())
        }
        .await;
        let _ = fs::remove_file(&index);
        commit
    }

    async fn create_worktree(&self, input: &WorktreeCreate) -> WorktreeCreated {
        let refused = |reason: &str| WorktreeCreated::Refused { reason: reason.to_owned() };
        if input.branch.is_empty() {
            return refused("no branch");
        }
        let root = real_path_or(&input.repo_root);
        if !self.ok(&root, &["rev-parse", "--git-dir"]).await {
            return refused("not a git repo");
        }
        let dir = input.worktree_dir.clone().unwrap_or_else(|| managed_dir(&root, &input.branch));
        if let Some(parent) = dir.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let start_point = if input.carry_uncommitted { self.snapshot_dirty_state(&root).await } else { None };
        let dir_text = dir.to_string_lossy().into_owned();
        let mut args = vec!["worktree", "add", dir_text.as_str(), "-b", input.branch.as_str()];
        args.extend(start_point.as_deref());
        if let Err(e) = self.run(&root, &args).await {
            let said = e.stderr.as_deref().map(str::trim).unwrap_or_default();
            return refused(if said.is_empty() { "worktree add failed" } else { said });
        }
        let worktree_dir = real_path_or(&dir);
        // Dependencies the source keeps out of git, so the agent can build on
        // its first turn. Best effort: a failed copy never fails the spawn.
        hydrate_worktree(self, &root, &worktree_dir, input.hydrate_env).await;
        let fork_base_sha = self.line(&worktree_dir, &["rev-parse", "HEAD"]).await;
        WorktreeCreated::Created { worktree_dir, fork_base_sha }
    }

    async fn remove_worktree(&self, worktree: &WorktreeRef) -> WorktreeRemoved {
        if worktree.branch.is_empty() {
            return WorktreeRemoved::Refused { reason: "no branch" };
        }
        let root = real_path_or(&worktree.repo_root);
        let dir = worktree.worktree_dir.clone().unwrap_or_else(|| managed_dir(&root, &worktree.branch));
        // Never the repository's own working tree.
        if real_path_or(&dir) == root {
            return WorktreeRemoved::Refused { reason: "refusing repo root" };
        }
        let dir_text = dir.to_string_lossy().into_owned();
        // Removed whatever is uncommitted in it; then stale entries a
        // half-finished removal left are cleared.
        self.ok(&root, &["worktree", "remove", &dir_text, "--force"]).await;
        self.ok(&root, &["worktree", "prune"]).await;
        // The folder must be gone, but only a folder under `.eos/worktrees/` is removed by hand.
        if dir.exists() && is_managed_dir(&dir) {
            let _ = fs::remove_dir_all(&dir);
            self.ok(&root, &["worktree", "prune"]).await;
        }
        // Commits only this branch holds stay reachable under a tag; in the
        // shared object store that costs next to nothing.
        let branch = worktree.branch.as_str();
        let unmerged = self.text(&root, &["rev-list", "--count", branch, "--not", "HEAD"]).await;
        if unmerged.is_some_and(|out| parse_int(out.trim()).unwrap_or(0) > 0) {
            let tag = format!("eos/trash/{branch}-{}", self.now_base36());
            self.ok(&root, &["tag", &tag, branch]).await;
        }
        self.ok(&root, &["branch", "-D", branch]).await;
        WorktreeRemoved::Removed
    }
}

impl WorktreeManager for Git {
    fn create<'a>(&'a self, input: &'a WorktreeCreate) -> BoxFuture<'a, WorktreeCreated> {
        Box::pin(self.create_worktree(input))
    }

    fn remove<'a>(&'a self, worktree: &'a WorktreeRef) -> BoxFuture<'a, WorktreeRemoved> {
        Box::pin(self.remove_worktree(worktree))
    }

    fn list_worktrees<'a>(&'a self, repo_root: &'a Path) -> BoxFuture<'a, Vec<WorktreeEntry>> {
        Box::pin(async move {
            let root = real_path_or(repo_root);
            self.text(&root, &["worktree", "list", "--porcelain"])
                .await
                .map(|out| parse_worktree_list(&out))
                .unwrap_or_default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base36_matches_javascript() {
        // (1767259800125).toString(36) and friends, from Node.
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(1_767_259_800_125), "mjv8uszh");
    }

    #[test]
    fn the_porcelain_list_names_the_main_worktree_first() {
        let out = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.eos/worktrees/eos-1\nHEAD def\nbranch refs/heads/eos-1\nlocked reason\n\nworktree /elsewhere\nHEAD 123\ndetached\n";
        let entries = parse_worktree_list(out);
        assert_eq!(entries.len(), 3);
        assert_eq!((entries[0].path.as_path(), entries[0].is_main), (Path::new("/repo"), true));
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!((entries[1].branch.as_deref(), entries[1].locked, entries[1].is_main), (Some("eos-1"), true, false));
        assert_eq!(entries[2].branch, None);
        assert!(parse_worktree_list("worktree /bare\nbare\n\nworktree /wt\nbare\n")[1].is_main);
    }

    #[test]
    fn only_folders_under_eos_worktrees_are_managed() {
        assert!(is_managed_dir(Path::new("/repo/.eos/worktrees/eos-1")));
        assert!(!is_managed_dir(Path::new("/repo/.eos/worktrees")));
        assert!(!is_managed_dir(Path::new("/repo/worktrees/eos-1")));
        assert!(!is_managed_dir(Path::new("/repo")));
    }
}
