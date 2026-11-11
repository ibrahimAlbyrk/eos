use std::path::Path;

use eos_contracts::{CommitDetail, CommitFile, CommitFileStatus, FsStashEntry, Num, UnpushedCommit};
use eos_core::BoxFuture;
use eos_core::git::{ConflictEntry, GitDirs, GitInfo, SyncStatus};
use eos_domain::git::changes::{parse_name_status_z, parse_numstat_z, parse_porcelain_z};
use eos_domain::git::conflict::is_unmerged_code;
use eos_domain::git::pull_plan::PullState;
use eos_domain::git::push_plan::PushState;
use eos_kit_fs::path::normalize;

use crate::Git;
use crate::records::{
    FIRST_PARENT_DIFF, IGNORE_DIRTY_SUBMODULES, LOG_FORMAT, STASH_FORMAT, parse_log_records, parse_recent_checkouts,
    parse_stash_records, web_url,
};
use crate::run::parse_int;

/// How many reflog entries are read for the recent branches: enough for the
/// picker, and a bound on a long-lived repository's reflog.
const REFLOG_ENTRIES: &str = "300";

fn lines(out: &str) -> Vec<String> {
    out.split('\n').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// A path Eos keeps inside the repository for its worktrees.
pub(crate) fn is_managed(path: &str) -> bool {
    path == ".eos" || path.starts_with(".eos/")
}

fn status_from(status: eos_contracts::ChangedFileStatus) -> CommitFileStatus {
    use eos_contracts::ChangedFileStatus as S;
    match status {
        S::M => CommitFileStatus::M,
        S::A => CommitFileStatus::A,
        S::D => CommitFileStatus::D,
        S::R => CommitFileStatus::R,
    }
}

impl Git {
    /// `<behind>\t<ahead>` of `git rev-list --left-right --count @{u}...HEAD`.
    async fn behind_ahead(&self, cwd: &Path) -> Option<(Option<i64>, Option<i64>)> {
        let out = self.text(cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).await?;
        let mut parts = out.split_whitespace();
        Some((parse_int(parts.next().unwrap_or("0")), parse_int(parts.next().unwrap_or("0"))))
    }

    async fn push_state_of(&self, cwd: &Path) -> PushState {
        let branch = self.line(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await.filter(|branch| branch != "HEAD");
        // The upstream (`origin/feature/x`) says both that there is one and which remote it is on.
        let upstream = self.line(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await;
        let has_upstream = upstream.is_some();
        let mut remote = upstream.and_then(|up| up.split('/').next().filter(|r| !r.is_empty()).map(str::to_owned));
        let (mut ahead, mut behind) = (0, 0);
        if has_upstream && let Some((b, a)) = self.behind_ahead(cwd).await {
            behind = b.and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
            ahead = a.and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
        }
        // No upstream yet: push to origin, else to the first remote.
        if remote.is_none()
            && let Some(out) = self.text(cwd, &["remote"]).await
        {
            let remotes = lines(&out);
            remote = if remotes.iter().any(|r| r == "origin") {
                Some("origin".to_owned())
            } else {
                remotes.into_iter().next()
            };
        }
        PushState { branch, remote, has_upstream, ahead, behind }
    }

    async fn commit_detail_of(&self, cwd: &Path, sha: &str) -> Option<CommitDetail> {
        let meta = self.text(cwd, &["show", "-s", "--format=%h%x1f%an%x1f%ct%x1f%s%x1f%b", sha]).await?;
        let mut fields = meta.split('\x1f');
        let short = fields.next().map(str::trim).filter(|s| !s.is_empty())?.to_owned();
        let author = fields.next().unwrap_or_default().to_owned();
        let ts = parse_int(fields.next().unwrap_or_default()).unwrap_or(0).saturating_mul(1000);
        let subject = fields.next().unwrap_or_default().to_owned();
        let body = fields.next().unwrap_or_default().trim().to_owned();

        let names = ["show", sha, FIRST_PARENT_DIFF, "--name-status", "-z", "--format="];
        let counts = ["show", sha, FIRST_PARENT_DIFF, "--numstat", "-z", "--format="];
        let (name_status, numstat) = tokio::join!(self.run(cwd, &names), self.run(cwd, &counts));
        let (name_status, numstat) = (name_status.ok()?.text(), numstat.ok()?.text());
        let counts = parse_numstat_z(&numstat);
        let files: Vec<CommitFile> = parse_name_status_z(&name_status)
            .into_iter()
            .map(|entry| {
                // The last numstat row for a path wins, as when the rows are put in a map.
                let row = counts.iter().rev().find(|n| n.path == entry.path);
                CommitFile {
                    old_path: entry.old_path.filter(|p| !p.is_empty()),
                    status: status_from(entry.status),
                    insertions: row.and_then(|n| n.insertions),
                    deletions: row.and_then(|n| n.deletions),
                    path: entry.path,
                }
            })
            .collect();
        Some(CommitDetail {
            sha: short,
            author,
            ts: Num::from(ts),
            subject,
            body,
            insertions: files.iter().map(|f| f.insertions.unwrap_or(0)).sum(),
            deletions: files.iter().map(|f| f.deletions.unwrap_or(0)).sum(),
            files,
        })
    }
}

impl GitInfo for Git {
    fn is_repo<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            self.text(cwd, &["rev-parse", "--is-inside-work-tree"]).await.is_some_and(|out| out.trim() == "true")
        })
    }

    fn git_dirs<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<GitDirs>> {
        Box::pin(async move {
            let toplevel = self.line(cwd, &["rev-parse", "--show-toplevel"]).await?;
            let git_dir = self.line(cwd, &["rev-parse", "--absolute-git-dir"]).await?;
            let git_dir = normalize(Path::new(&git_dir));
            // Absolute in a linked worktree, relative to `cwd` in the main checkout (often `.git`).
            let common = self.text(cwd, &["rev-parse", "--git-common-dir"]).await?;
            let common = common.trim();
            let common_dir = if common.is_empty() { git_dir.clone() } else { normalize(&cwd.join(common)) };
            Some(GitDirs { toplevel: normalize(Path::new(&toplevel)), git_dir, common_dir })
        })
    }

    fn list_branches<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            self.text(cwd, &["branch", "--format=%(refname:short)"]).await.map(|out| lines(&out)).unwrap_or_default()
        })
    }

    fn remote_branches<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            let Some(out) = self.text(cwd, &["branch", "-r", "--format=%(refname:short)"]).await else {
                return Vec::new();
            };
            lines(&out).into_iter().filter(|branch| !branch.ends_with("/HEAD")).collect()
        })
    }

    fn remotes<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move { self.text(cwd, &["remote"]).await.map(|out| lines(&out)).unwrap_or_default() })
    }

    fn current_branch<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        // `--show-current` names the branch of a repository with no commit
        // yet, and prints nothing on a detached HEAD.
        Box::pin(async move { self.line(cwd, &["branch", "--show-current"]).await })
    }

    fn recent_checkouts<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            self.text(cwd, &["reflog", "-n", REFLOG_ENTRIES, "--format=%gs"])
                .await
                .map(|out| parse_recent_checkouts(&out))
                .unwrap_or_default()
        })
    }

    fn remote_url<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.line(cwd, &["remote", "get-url", "origin"]).await.map(|raw| web_url(&raw)) })
    }

    fn sync_status<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<SyncStatus>> {
        Box::pin(async move {
            let (behind, ahead) = self.behind_ahead(cwd).await?;
            Some(SyncStatus { ahead: u32::try_from(ahead?).ok()?, behind: u32::try_from(behind?).ok()? })
        })
    }

    fn stash_count<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, u32> {
        Box::pin(async move {
            let Some(out) = self.text(cwd, &["stash", "list", "--format=%H"]).await else { return 0 };
            let out = out.trim();
            if out.is_empty() { 0 } else { out.split('\n').count() as u32 }
        })
    }

    fn stash_list<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<FsStashEntry>> {
        Box::pin(async move {
            self.text(cwd, &["stash", "list", STASH_FORMAT])
                .await
                .map(|out| parse_stash_records(&out))
                .unwrap_or_default()
        })
    }

    fn conflict_count<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, u32> {
        Box::pin(async move {
            let Some(out) = self.text(cwd, &["status", "--porcelain", IGNORE_DIRTY_SUBMODULES]).await else {
                return 0;
            };
            out.split('\n').filter(|line| line.get(..2).is_some_and(is_unmerged_code)).count() as u32
        })
    }

    fn conflict_list<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<ConflictEntry>> {
        Box::pin(async move {
            let Some(out) = self.text(cwd, &["status", "--porcelain=v1", "-z", IGNORE_DIRTY_SUBMODULES]).await else {
                return Vec::new();
            };
            parse_porcelain_z(&out)
                .into_iter()
                .filter(|e| is_unmerged_code(&e.xy()) && !e.path.starts_with(".eos/"))
                .map(|e| ConflictEntry { xy: e.xy(), path: e.path })
                .collect()
        })
    }

    fn unpushed_commits<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Vec<UnpushedCommit>> {
        Box::pin(async move {
            self.text(cwd, &["log", "@{u}..HEAD", LOG_FORMAT])
                .await
                .map(|out| parse_log_records(&out))
                .unwrap_or_default()
        })
    }

    fn log<'a>(&'a self, cwd: &'a Path, limit: u32, skip: u32) -> BoxFuture<'a, Vec<UnpushedCommit>> {
        Box::pin(async move {
            let (count, skip) = ((limit.saturating_add(1)).to_string(), format!("--skip={skip}"));
            self.text(cwd, &["log", "HEAD", "-n", &count, &skip, LOG_FORMAT])
                .await
                .map(|out| parse_log_records(&out))
                .unwrap_or_default()
        })
    }

    fn rev_parse<'a>(&'a self, cwd: &'a Path, rev: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.line(cwd, &["rev-parse", "--short", rev]).await })
    }

    fn commit_detail<'a>(&'a self, cwd: &'a Path, sha: &'a str) -> BoxFuture<'a, Option<CommitDetail>> {
        Box::pin(self.commit_detail_of(cwd, sha))
    }

    fn merge_base<'a>(&'a self, cwd: &'a Path, other_root: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let other = self.line(other_root, &["rev-parse", "HEAD"]).await?;
            self.line(cwd, &["merge-base", "HEAD", &other]).await
        })
    }

    fn merge_base_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.line(cwd, &["merge-base", "HEAD", "--end-of-options", rev]).await })
    }

    fn default_base_ref<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            if let Some(head) = self.line(cwd, &["rev-parse", "--abbrev-ref", "origin/HEAD"]).await
                && head != "origin/HEAD"
            {
                return Some(head);
            }
            for name in ["origin/main", "origin/master", "main", "master"] {
                let commit = format!("{name}^{{commit}}");
                if self.run(cwd, &["rev-parse", "--verify", "--quiet", &commit]).await.is_ok() {
                    return Some(name.to_owned());
                }
            }
            None
        })
    }

    fn push_state<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PushState> {
        Box::pin(self.push_state_of(cwd))
    }

    fn pull_state<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, PullState> {
        Box::pin(async move {
            let s = self.push_state_of(cwd).await;
            PullState { branch: s.branch, has_upstream: s.has_upstream, ahead: s.ahead, behind: s.behind }
        })
    }

    fn has_uncommitted_changes<'a>(&'a self, cwd: &'a Path) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let Some(out) = self.text(cwd, &["status", "--porcelain", IGNORE_DIRTY_SUBMODULES]).await else {
                return false;
            };
            out.split('\n').any(|line| {
                let path: String = line.chars().skip(3).collect();
                let path = path.trim();
                !path.is_empty() && !is_managed(path)
            })
        })
    }
}
