//! The git reads, answered from the kept parts as the git adapter answers
//! them. A folder git cannot place in a tree (a git folder itself, one that
//! is gone, an untrusted one) is asked of git directly; one that is not in a
//! repository answers empty, as every command there fails. Reads that are
//! not kept (history, one file's diff, blobs, stashes) go to git as before.

use std::path::Path;
use std::sync::Arc;

use eos_contracts::{ChangedFile, CommitDetail, FileDiffResponse, FsStashEntry, UnpushedCommit};
use eos_core::BoxFuture;
use eos_core::git::{ConflictEntry, DiffStat, GitDiffs, GitDirs, GitInfo, SyncStatus};
use eos_domain::git::pull_plan::PullState;
use eos_domain::git::push_plan::PushState;

use super::status::{Listing, Missing, StatusList};
use super::{Place, Snapshots, TreeRef};

/// How a read is answered for a folder.
enum Answer {
    /// From the tree's parts; `prefix` is the folder below the tree's top.
    Kept { tree: Arc<TreeRef>, prefix: String },
    /// Not in a repository: what every failed command answers.
    Empty,
    /// By git, as before.
    Git,
}

impl Snapshots {
    async fn answer(&self, cwd: &Path) -> Answer {
        match self.place(cwd).await.as_ref() {
            Place::In { tree, prefix, .. } => Answer::Kept { tree: tree.clone(), prefix: prefix.clone() },
            Place::NotRepo => Answer::Empty,
            Place::Unknown => Answer::Git,
        }
    }

    /// The status, unless it was too large to read in full: then the reads
    /// that never split untracked folders ask git themselves.
    async fn status_of(&self, tree: &Arc<TreeRef>) -> (Arc<Listing>, Option<Missing>) {
        let listing = self.listing(tree).await;
        let missing = listing.status.as_ref().err().copied();
        (listing, missing)
    }

    /// Line counts follow the folder asked from when `diff.relative` is set.
    async fn diffs_follow_folder(&self, tree: &Arc<TreeRef>, prefix: &str) -> bool {
        !prefix.is_empty() && self.refs(tree).await.diff_relative
    }
}

fn status(listing: &Listing) -> Option<&StatusList> {
    listing.status.as_ref().ok()
}

impl GitInfo for Snapshots {
    fn is_repo<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { .. } => true,
                Answer::Empty => false,
                Answer::Git => self.git().is_repo(cwd).await,
            }
        })
    }

    fn git_dirs<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<GitDirs>> {
        Box::pin(async move {
            match self.place(cwd).await.as_ref() {
                Place::In { dirs, .. } => Some(dirs.clone()),
                Place::NotRepo => None,
                Place::Unknown => self.git().git_dirs(cwd).await,
            }
        })
    }

    fn list_branches<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.refs(&tree).await.branches.clone(),
                Answer::Empty => Vec::new(),
                Answer::Git => self.git().list_branches(cwd).await,
            }
        })
    }

    fn remote_branches<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.picker(&tree).await.remote_branches.clone(),
                Answer::Empty => Vec::new(),
                Answer::Git => self.git().remote_branches(cwd).await,
            }
        })
    }

    fn remotes<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.refs(&tree).await.remotes.clone(),
                Answer::Empty => Vec::new(),
                Answer::Git => self.git().remotes(cwd).await,
            }
        })
    }

    fn current_branch<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.refs(&tree).await.current_branch.clone(),
                Answer::Empty => None,
                Answer::Git => self.git().current_branch(cwd).await,
            }
        })
    }

    fn recent_checkouts<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.picker(&tree).await.recent.clone(),
                Answer::Empty => Vec::new(),
                Answer::Git => self.git().recent_checkouts(cwd).await,
            }
        })
    }

    fn remote_url<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.refs(&tree).await.remote_url.clone(),
                Answer::Empty => None,
                Answer::Git => self.git().remote_url(cwd).await,
            }
        })
    }

    fn sync_status<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<SyncStatus>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.refs(&tree).await.sync,
                Answer::Empty => None,
                Answer::Git => self.git().sync_status(cwd).await,
            }
        })
    }

    fn stash_count<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, u32> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.refs(&tree).await.stash,
                Answer::Empty => 0,
                Answer::Git => self.git().stash_count(cwd).await,
            }
        })
    }

    fn stash_list<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<FsStashEntry>> {
        self.git().stash_list(cwd)
    }

    fn conflict_count<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, u32> {
        Box::pin(async move {
            if let Answer::Kept { tree, .. } = self.answer(cwd).await {
                let (listing, missing) = self.status_of(&tree).await;
                if missing != Some(Missing::TooLarge) {
                    return status(&listing).map_or(0, StatusList::conflict_count);
                }
            }
            self.git().conflict_count(cwd).await
        })
    }

    fn conflict_list<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<ConflictEntry>> {
        Box::pin(async move {
            if let Answer::Kept { tree, .. } = self.answer(cwd).await {
                let (listing, missing) = self.status_of(&tree).await;
                if missing != Some(Missing::TooLarge) {
                    return status(&listing).map(StatusList::conflicts).unwrap_or_default();
                }
            }
            self.git().conflict_list(cwd).await
        })
    }

    fn unpushed_commits<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<UnpushedCommit>> {
        self.git().unpushed_commits(cwd)
    }

    fn log<'a>(&'a self, cwd: &'a Path, limit: u32, skip: u32) -> BoxFuture<'a, Vec<UnpushedCommit>> {
        self.git().log(cwd, limit, skip)
    }

    fn rev_parse<'a>(&'a self, cwd: &'a Path, rev: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            // `HEAD:./x` names a path relative to the folder asked from.
            if rev.contains(':') {
                return self.git().rev_parse(cwd, rev).await;
            }
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.rev(&tree, rev).await.as_ref().clone(),
                Answer::Empty => None,
                Answer::Git => self.git().rev_parse(cwd, rev).await,
            }
        })
    }

    fn commit_detail<'a>(&'a self, cwd: &'a Path, sha: &'a str) -> BoxFuture<'a, Option<CommitDetail>> {
        self.git().commit_detail(cwd, sha)
    }

    fn merge_base<'a>(&'a self, cwd: &'a Path, other_root: &'a Path) -> BoxFuture<'a, Option<String>> {
        // Depends on another tree's HEAD, which this tree's changes do not report.
        self.git().merge_base(cwd, other_root)
    }

    fn merge_base_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.merge_base(&tree, rev).await.as_ref().clone(),
                Answer::Empty => None,
                Answer::Git => self.git().merge_base_ref(cwd, rev).await,
            }
        })
    }

    fn default_base_ref<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.default_base(&tree).await.as_ref().clone(),
                Answer::Empty => None,
                Answer::Git => self.git().default_base_ref(cwd).await,
            }
        })
    }

    fn push_state<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PushState> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => self.refs(&tree).await.push.clone(),
                Answer::Empty => PushState::default(),
                Answer::Git => self.git().push_state(cwd).await,
            }
        })
    }

    fn pull_state<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PullState> {
        Box::pin(async move {
            let s = self.push_state(cwd).await;
            PullState { branch: s.branch, has_upstream: s.has_upstream, ahead: s.ahead, behind: s.behind }
        })
    }

    fn has_uncommitted_changes<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, .. } => {
                    let (listing, missing) = self.status_of(&tree).await;
                    if missing != Some(Missing::TooLarge) {
                        return status(&listing).is_some_and(StatusList::has_uncommitted);
                    }
                }
                Answer::Empty => return false,
                Answer::Git => {}
            }
            self.git().has_uncommitted_changes(cwd).await
        })
    }
}

impl GitDiffs for Snapshots {
    fn diff_short_stat<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, DiffStat> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, prefix } if !self.diffs_follow_folder(&tree, &prefix).await => {
                    let (listing, missing) = self.status_of(&tree).await;
                    if missing != Some(Missing::TooLarge) {
                        let mut stat = match base {
                            None => listing.stat(),
                            Some(base) => self.against(&tree, base).await.stat(),
                        };
                        stat.files += status(&listing).map_or(0, |s| s.untracked_below(&prefix));
                        return stat;
                    }
                }
                Answer::Empty => return DiffStat::default(),
                _ => {}
            }
            self.git().diff_short_stat(cwd, base).await
        })
    }

    fn changed_files<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, Vec<ChangedFile>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, prefix } if !self.diffs_follow_folder(&tree, &prefix).await => match base {
                    None => self.listing(&tree).await.changed(),
                    Some(base) => {
                        let (listing, against) = tokio::join!(self.listing(&tree), self.against(&tree, base));
                        against.changed(&listing)
                    }
                },
                Answer::Empty => Vec::new(),
                _ => self.git().changed_files(cwd, base).await,
            }
        })
    }

    fn file_diff<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a str,
        old_path: Option<&'a str>,
        base: Option<&'a str>,
    ) -> BoxFuture<'a, FileDiffResponse> {
        self.git().file_diff(cwd, path, old_path, base)
    }

    fn full_diff<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            match self.answer(cwd).await {
                Answer::Kept { tree, prefix } if !self.diffs_follow_folder(&tree, &prefix).await => {
                    self.patch(&tree, base).await.as_ref().clone()
                }
                Answer::Empty => None,
                _ => self.git().full_diff(cwd, base).await,
            }
        })
    }

    fn commit_patch<'a>(&'a self, cwd: &'a Path, sha: &'a str) -> BoxFuture<'a, Option<String>> {
        self.git().commit_patch(cwd, sha)
    }

    fn commit_file_diff<'a>(
        &'a self,
        cwd: &'a Path,
        sha: &'a str,
        path: &'a str,
        old_path: Option<&'a str>,
    ) -> BoxFuture<'a, FileDiffResponse> {
        self.git().commit_file_diff(cwd, sha, path, old_path)
    }

    fn blob_size_at_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str, path: &'a str) -> BoxFuture<'a, Option<u64>> {
        self.git().blob_size_at_ref(cwd, rev, path)
    }

    fn blob_at_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str, path: &'a str) -> BoxFuture<'a, Option<Vec<u8>>> {
        self.git().blob_at_ref(cwd, rev, path)
    }

    fn conflict_file_content<'a>(&'a self, cwd: &'a Path, path: &'a str) -> BoxFuture<'a, String> {
        self.git().conflict_file_content(cwd, path)
    }

    fn stage_content<'a>(&'a self, cwd: &'a Path, path: &'a str, stage: u8) -> BoxFuture<'a, Option<String>> {
        self.git().stage_content(cwd, path, stage)
    }
}
