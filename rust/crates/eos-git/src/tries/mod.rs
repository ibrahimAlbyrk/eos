//! Try: a worker's work shown in the user's checkout as unstaged edits
//! (`infra/src/git/ChildProcessBranchIntegration.ts`).
//!
//! Plain plumbing; no merge state is ever made in the checkout. `git apply`
//! checks every hunk before it writes, so a failed apply leaves the tree as it
//! was. Discarding applies the layer's patch in reverse (anchored on context,
//! so it holds while HEAD moves), after checking every touched file still
//! holds what the apply left there.
//!
//! Tries stack, oldest first. A new layer's patch is the difference between
//! the stack's virtual tree (HEAD with every layer merged in, through
//! synthetic commits) and that tree merged with the new snapshot, so Tries of
//! different workers compose. Keeping changes no file and works in any order;
//! discarding is refused while a later layer touches the same files.

mod state;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use eos_contracts::{ActiveTry, TryPreviewResponse};
use eos_core::BoxFuture;
use eos_core::git::{BranchIntegration, TryApplied, TryApplyRefusal, TryDiscardRefusal, TryDiscarded, TrySync};
use eos_domain::WorkerBranch;

use crate::Git;
use crate::plumbing::{SnapshotFor, live_worktree};
use crate::run::parse_int;
use crate::worktree::real_path_or;
use state::{Layer, LayerFile, StateDir};

/// Files whose change usually means dependencies must be installed again.
const LOCKFILES: [&str; 5] = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];

fn has_lockfile(files: &[String]) -> bool {
    files.iter().any(|f| LOCKFILES.contains(&f.rsplit('/').next().unwrap_or(f)))
}

fn snapshot_ref(worker_id: &str) -> String {
    format!("refs/eos/snapshots/{worker_id}")
}

fn refused(reason: TryApplyRefusal) -> TryApplied {
    TryApplied::Refused { reason, files: None, detail: None }
}

fn refused_files(reason: TryApplyRefusal, files: Vec<String>) -> TryApplied {
    TryApplied::Refused { reason, files: Some(files), detail: None }
}

fn git_error(detail: impl Into<String>) -> TryApplied {
    TryApplied::Refused { reason: TryApplyRefusal::GitError, files: None, detail: Some(detail.into()) }
}

/// The first layer after `index` that touches one of `paths`, with the paths it shares.
fn overlay<'a>(tries: &'a [Layer], index: usize, paths: &[String]) -> Option<(&'a Layer, Vec<String>)> {
    tries[index + 1..].iter().find_map(|above| {
        let shared: Vec<String> = above.files.iter().map(|f| f.path.clone()).filter(|p| paths.contains(p)).collect();
        (!shared.is_empty()).then_some((above, shared))
    })
}

/// The commit and tree a layer merges onto.
struct StackBase {
    commit: String,
    tree: String,
}

/// One lock per checkout: two writes to the same checkout never interleave.
/// An entry lives while someone holds its lock.
#[derive(Default)]
struct CheckoutLocks(Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>);

impl CheckoutLocks {
    fn of(&self, root: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(root.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

/// The Try adapter: git plus the folder where each checkout's Tries are kept
/// (`<data>/tries`).
pub struct GitTries {
    git: Git,
    tries_dir: PathBuf,
    locks: CheckoutLocks,
}

impl std::fmt::Debug for GitTries {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitTries").field("tries_dir", &self.tries_dir).finish_non_exhaustive()
    }
}

impl GitTries {
    pub fn new(git: Git, tries_dir: PathBuf) -> Self {
        Self { git, tries_dir, locks: CheckoutLocks::default() }
    }

    fn state(&self, real_root: &Path) -> StateDir {
        StateDir::new(&self.tries_dir, real_root)
    }

    /// HEAD with every layer of `tries` merged in, in order. Only refs move;
    /// nothing in the checkout does.
    async fn rebuild_stack(&self, root: &Path, tries: &[Layer]) -> Result<StackBase, String> {
        let git = &self.git;
        let head = git.call(root, &["rev-parse", "HEAD"]).await;
        let head_tree = git.call(root, &["rev-parse", "HEAD^{tree}"]).await;
        if !head.ok() || !head_tree.ok() {
            return Err("rev-parse HEAD failed".into());
        }
        let mut base = StackBase { commit: head.trimmed(), tree: head_tree.trimmed() };
        for layer in tries {
            let id = &layer.worker_id;
            let mut snapshot = git.call(root, &["rev-parse", "--verify", "--quiet", &snapshot_ref(id)]).await.trimmed();
            if let (true, Some(pinned)) = (snapshot.is_empty(), &layer.snapshot_sha)
                && git.call(root, &["cat-file", "-e", &format!("{pinned}^{{commit}}")]).await.ok()
            {
                snapshot.clone_from(pinned);
            }
            if snapshot.is_empty() {
                return Err(format!("snapshot for active try {id} is gone — keep or discard it first"));
            }
            let merge = git.merge_tree(root, &base.commit, &snapshot).await;
            let Some(tree) = merge.clean_tree().map(str::to_owned) else {
                return Err(format!(
                    "active try {id} no longer merges cleanly against HEAD — keep or discard it first"
                ));
            };
            let wrap = git
                .call(root, &["commit-tree", &tree, "-p", &base.commit, "-p", &snapshot, "-m", "eos try stack"])
                .await;
            if !wrap.ok() {
                return Err("stack commit-tree failed".into());
            }
            base = StackBase { commit: wrap.trimmed(), tree };
        }
        Ok(base)
    }

    async fn preview_try(&self, worker: &WorkerBranch) -> TryPreviewResponse {
        let root = real_path_or(&worker.repo_root);
        let active_tries: Vec<ActiveTry> =
            self.state(&root).load().iter().filter(|t| !t.is_kept()).map(Layer::to_active).collect();
        let empty = |supported: bool, ahead: i64, behind: i64| TryPreviewResponse {
            supported,
            ahead,
            behind,
            conflicts: Vec::new(),
            files: Vec::new(),
            lockfile_changed: false,
            active_tries: active_tries.clone(),
        };
        let Some(snapshot) = self.git.snapshot(worker, &root, SnapshotFor::Try).await else {
            return empty(false, 0, 0);
        };
        let counts =
            self.git.call(&root, &["rev-list", "--left-right", "--count", &format!("HEAD...{snapshot}")]).await;
        let counts = counts.trimmed();
        let mut sides = counts.split_whitespace().map(|n| parse_int(n).unwrap_or(0));
        let (behind, ahead) = (sides.next().unwrap_or(0), sides.next().unwrap_or(0));
        let merge = self.git.merge_tree(&root, "HEAD", &snapshot).await;
        let Some(tree) = merge.tree.as_deref().filter(|_| merge.supported) else {
            return empty(merge.supported, ahead, behind);
        };
        let files = self.git.diff_names(&root, "HEAD", tree).await;
        TryPreviewResponse {
            supported: true,
            ahead,
            behind,
            conflicts: merge.conflicts,
            lockfile_changed: has_lockfile(&files),
            files,
            active_tries,
        }
    }

    async fn apply_try(&self, worker: &WorkerBranch) -> TryApplied {
        let git = &self.git;
        let root = real_path_or(&worker.repo_root);
        let lock = self.locks.of(&root);
        let _held = lock.lock().await;
        let state = self.state(&root);
        let mut tries = state.load();
        // A layer the worker has already (open or kept) is synced in place over the layers below it.
        let index = tries.iter().position(|t| t.worker_id == worker.worker_id);
        let below = &tries[..index.unwrap_or(tries.len())];

        let Some(snapshot) = git.snapshot(worker, &root, SnapshotFor::Try).await else {
            return git_error("snapshot failed");
        };
        // Conflicts with HEAD need the git agent; those only with the stack need a layer resolved.
        let head_merge = git.merge_tree(&root, "HEAD", &snapshot).await;
        if !head_merge.supported {
            return TryApplied::Refused {
                reason: TryApplyRefusal::Unsupported,
                files: None,
                detail: Some("git >= 2.38 required (merge-tree --write-tree)".into()),
            };
        }
        if !head_merge.conflicts.is_empty() {
            return refused_files(TryApplyRefusal::Conflicts, head_merge.conflicts);
        }
        let Some(mut merged_tree) = head_merge.tree else { return git_error("merge-tree produced no tree") };

        let base = match self.rebuild_stack(&root, below).await {
            Ok(base) => base,
            Err(detail) => return git_error(detail),
        };
        if let Some(top) = below.last() {
            let merge = git.merge_tree(&root, &base.commit, &snapshot).await;
            let Some(tree) = merge.tree.clone().filter(|_| merge.supported) else {
                return git_error("stack merge-tree failed");
            };
            if !merge.conflicts.is_empty() {
                let owners: Vec<&str> = below
                    .iter()
                    .filter(|t| merge.conflicts.iter().any(|c| t.touches(c)))
                    .map(|t| t.worker_id.as_str())
                    .collect();
                let detail = if owners.is_empty() { top.worker_id.clone() } else { owners.join(",") };
                return TryApplied::Refused {
                    reason: TryApplyRefusal::ConflictsWithTry,
                    files: Some(merge.conflicts),
                    detail: Some(detail),
                };
            }
            merged_tree = tree;
        }

        // Everything this layer brings over its floor: what a discard reverses and checks.
        let layer_files = git.diff_names(&root, &base.tree, &merged_tree).await;
        if layer_files.is_empty() {
            return refused(TryApplyRefusal::NothingToApply);
        }

        let (from_tree, delta) = match index {
            Some(i) => {
                let previous = tries[i].snapshot_sha.clone().unwrap_or_default();
                let prev = git.merge_tree(&root, &base.commit, &previous).await;
                let Some(prev_tree) = prev.clean_tree().map(str::to_owned) else {
                    return git_error("previous snapshot no longer projects cleanly — discard and re-apply");
                };
                let delta = git.diff_names(&root, &prev_tree, &merged_tree).await;
                if delta.is_empty() {
                    return refused(TryApplyRefusal::NothingToApply);
                }
                if let Some((above, shared)) = overlay(&tries, i, &delta) {
                    return TryApplied::Refused {
                        reason: TryApplyRefusal::BlockedByOverlay,
                        files: Some(shared),
                        detail: Some(above.worker_id.clone()),
                    };
                }
                // The checkout must still hold what was applied: a hand edit is never overwritten.
                let mut dirty = Vec::new();
                for file in &delta {
                    if git.hash_of(&root, file).await != git.blob_in_tree(&root, &prev_tree, file).await {
                        dirty.push(file.clone());
                    }
                }
                if !dirty.is_empty() {
                    return refused_files(TryApplyRefusal::DirtyFiles, dirty);
                }
                (prev_tree, delta)
            }
            None => {
                // A file a layer below touched must hold that layer's content; any
                // other must be clean. The rest of the checkout may be dirty.
                let expected: HashMap<&str, Option<&str>> =
                    below.iter().flat_map(|t| t.files.iter().map(|f| (f.path.as_str(), f.hash.as_deref()))).collect();
                let (mut dirty, mut unlayered) = (Vec::new(), Vec::new());
                for file in &layer_files {
                    match expected.get(file.as_str()) {
                        Some(hash) => {
                            if git.hash_of(&root, file).await.as_deref() != *hash {
                                dirty.push(file.clone());
                            }
                        }
                        None => unlayered.push(file.clone()),
                    }
                }
                dirty.extend(git.dirty_among(&root, &unlayered).await);
                if !dirty.is_empty() {
                    return refused_files(TryApplyRefusal::DirtyFiles, dirty);
                }
                (base.tree.clone(), layer_files.clone())
            }
        };

        let base_head = git.call(&root, &["rev-parse", "HEAD"]).await;
        if !base_head.ok() {
            return git_error(base_head.stderr);
        }
        // Only the patch from where the checkout stands; git checks it all before writing anything.
        let patch = git.call(&root, &["diff", "--binary", &from_tree, &merged_tree]).await;
        if !patch.ok() {
            return git_error("patch generation failed");
        }
        let tmp = state.apply_tmp_path(&worker.worker_id);
        if let Err(e) = write_file(&tmp, patch.stdout.clone()).await {
            return git_error(format!("the patch could not be written: {e}"));
        }
        let applied = git.call(&root, &["apply", "--whitespace=nowarn", &tmp.to_string_lossy()]).await;
        let _ = std::fs::remove_file(&tmp);
        if !applied.ok() {
            return git_error(applied.stderr.trim());
        }

        // The layer's whole patch from its floor, so a discard reverses it all however many syncs built it.
        let whole = if index.is_some() {
            git.call(&root, &["diff", "--binary", &base.tree, &merged_tree]).await
        } else {
            patch
        };
        if !whole.ok() {
            return git_error("cumulative patch failed");
        }
        if let Err(e) = write_file(&state.patch_path(&worker.worker_id), whole.stdout).await {
            return git_error(format!("the patch could not be written: {e}"));
        }
        // Pinned only now: the ref and the recorded snapshot never part after a failed sync.
        git.call(&root, &["update-ref", &snapshot_ref(&worker.worker_id), &snapshot]).await;

        let mut files = Vec::with_capacity(layer_files.len());
        for path in &layer_files {
            files.push(LayerFile { path: path.clone(), hash: git.hash_of(&root, path).await });
        }
        let layer = Layer {
            worker_id: worker.worker_id.clone(),
            branch: worker.branch.clone(),
            base_head: base_head.trimmed(),
            snapshot_sha: Some(snapshot),
            kept: Some(false),
            lockfile_changed: has_lockfile(&layer_files),
            created_at: index.map_or_else(|| git.clock.now_ms(), |i| tries[i].created_at),
            files,
        };
        match index {
            Some(i) => tries[i] = layer,
            None => tries.push(layer),
        }
        if let Err(e) = state.save(&tries) {
            return git_error(format!("the Try could not be saved: {e}"));
        }
        TryApplied::Applied { lockfile_changed: has_lockfile(&delta), files: delta }
    }

    async fn discard_try(&self, repo_root: &Path, worker_id: &str) -> TryDiscarded {
        let git = &self.git;
        let root = real_path_or(repo_root);
        let lock = self.locks.of(&root);
        let _held = lock.lock().await;
        let state = self.state(&root);
        let mut tries = state.load();
        let refusal = |reason, files, detail| TryDiscarded::Refused { reason, files, detail };
        let Some(index) = tries.iter().position(|t| t.worker_id == worker_id) else {
            return refusal(TryDiscardRefusal::NoActiveTry, None, None);
        };
        let mine: Vec<String> = tries[index].files.iter().map(|f| f.path.clone()).collect();
        if let Some((above, shared)) = overlay(&tries, index, &mine) {
            return refusal(TryDiscardRefusal::BlockedByOverlay, Some(shared), Some(above.worker_id.clone()));
        }
        // Every touched file must still hold what the apply left (a removed one must still be gone).
        let mut edited = Vec::new();
        for file in &tries[index].files {
            if git.hash_of(&root, &file.path).await != file.hash {
                edited.push(file.path.clone());
            }
        }
        if !edited.is_empty() {
            return refusal(TryDiscardRefusal::UserEdited, Some(edited), None);
        }
        let patch = state.patch_path(worker_id);
        let reversed = git.call(&root, &["apply", "-R", "--whitespace=nowarn", &patch.to_string_lossy()]).await;
        if !reversed.ok() {
            return refusal(TryDiscardRefusal::GitError, None, Some(reversed.stderr.trim().to_owned()));
        }
        git.call(&root, &["update-ref", "-d", &snapshot_ref(worker_id)]).await;
        let _ = std::fs::remove_file(patch);
        tries.remove(index);
        if let Err(e) = state.save(&tries) {
            return refusal(TryDiscardRefusal::GitError, None, Some(format!("the Try could not be saved: {e}")));
        }
        TryDiscarded::Discarded
    }

    async fn keep_try(&self, repo_root: &Path, worker_id: &str) -> bool {
        let root = real_path_or(repo_root);
        let lock = self.locks.of(&root);
        let _held = lock.lock().await;
        let state = self.state(&root);
        let mut tries = state.load();
        let Some(layer) = tries.iter_mut().find(|t| t.worker_id == worker_id) else { return false };
        layer.kept = Some(true);
        state.save(&tries).is_ok()
    }

    async fn sync_of(&self, worker: &WorkerBranch) -> TrySync {
        let git = &self.git;
        let root = real_path_or(&worker.repo_root);
        let tries = self.state(&root).load();
        // Never applied: nothing to sync, the dashboard offers a first apply.
        let Some(anchor) = tries.iter().find(|t| t.worker_id == worker.worker_id).and_then(|t| t.snapshot_sha.clone())
        else {
            return TrySync::default();
        };
        let anchor_tree = git.call(&root, &["rev-parse", "--verify", "--quiet", &format!("{anchor}^{{tree}}")]).await;
        let anchor_tree = anchor_tree.trimmed();
        let current = match live_worktree(worker) {
            Some(worktree) => git.worktree_tree(&worktree, "eos-sync", &worker.worker_id).await,
            None => {
                let tip = git.call(&root, &["rev-parse", "--verify", &format!("{}^{{tree}}", worker.branch)]).await;
                tip.ok().then(|| tip.trimmed())
            }
        };
        match current {
            Some(current) if !anchor_tree.is_empty() && current != anchor_tree => {
                let files = git.diff_names(&root, &anchor_tree, &current).await;
                TrySync { syncable: !files.is_empty(), files }
            }
            _ => TrySync::default(),
        }
    }

    async fn cleanup(&self, repo_root: &Path, worker_id: &str) {
        let root = real_path_or(repo_root);
        let lock = self.locks.of(&root);
        let _held = lock.lock().await;
        let state = self.state(&root);
        let mut tries = state.load();
        if let Some(index) = tries.iter().position(|t| t.worker_id == worker_id) {
            // An open Try stays so it can still be discarded; its ref stays pinned.
            if !tries[index].is_kept() {
                return;
            }
            // A kept one is settled: its edits stay as the user's own.
            tries.remove(index);
            if state.save(&tries).is_err() {
                return;
            }
            let _ = std::fs::remove_file(state.patch_path(worker_id));
        }
        self.git.call(&root, &["update-ref", "-d", &snapshot_ref(worker_id)]).await;
    }
}

async fn write_file(path: &Path, bytes: Vec<u8>) -> std::io::Result<()> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, bytes)
    })
    .await
    .map_err(std::io::Error::other)?
}

impl BranchIntegration for GitTries {
    fn preview<'a>(&'a self, worker: &'a WorkerBranch) -> BoxFuture<'a, TryPreviewResponse> {
        Box::pin(self.preview_try(worker))
    }

    fn apply<'a>(&'a self, worker: &'a WorkerBranch) -> BoxFuture<'a, TryApplied> {
        Box::pin(self.apply_try(worker))
    }

    fn discard<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, TryDiscarded> {
        Box::pin(self.discard_try(repo_root, worker_id))
    }

    fn keep<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(self.keep_try(repo_root, worker_id))
    }

    fn active_tries<'a>(&'a self, repo_root: &'a Path) -> BoxFuture<'a, Vec<ActiveTry>> {
        Box::pin(async move {
            let tries = self.state(&real_path_or(repo_root)).load();
            tries.iter().filter(|t| !t.is_kept()).map(Layer::to_active).collect()
        })
    }

    fn was_kept<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let state = self.state(&real_path_or(repo_root));
            state.load().iter().any(|t| t.worker_id == worker_id && t.is_kept())
                || state.legacy_kept().contains_key(worker_id)
        })
    }

    fn sync_status<'a>(&'a self, worker: &'a WorkerBranch) -> BoxFuture<'a, TrySync> {
        Box::pin(self.sync_of(worker))
    }

    fn cleanup_snapshot<'a>(&'a self, repo_root: &'a Path, worker_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(self.cleanup(repo_root, worker_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lockfile_is_known_by_its_name_in_any_folder() {
        assert!(has_lockfile(&["web/package-lock.json".into()]));
        assert!(has_lockfile(&["bun.lock".into()]));
        assert!(!has_lockfile(&["src/lock.rs".into(), "package.json".into()]));
    }

    #[test]
    fn the_first_overlapping_layer_above_is_named() {
        let layer = |id: &str, files: &[&str]| Layer {
            worker_id: id.into(),
            branch: format!("eos-{id}"),
            base_head: "h".into(),
            snapshot_sha: None,
            kept: None,
            lockfile_changed: false,
            created_at: 0,
            files: files.iter().map(|p| LayerFile { path: (*p).into(), hash: None }).collect(),
        };
        let tries = [layer("w-1", &["a"]), layer("w-2", &["b"]), layer("w-3", &["a", "c"])];
        let (above, shared) = overlay(&tries, 0, &["a".into()]).expect("an overlay");
        assert_eq!((above.worker_id.as_str(), shared), ("w-3", vec!["a".to_owned()]));
        assert!(overlay(&tries, 1, &["b".into()]).is_none());
    }
}
