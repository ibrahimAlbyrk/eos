use std::path::Path;

use eos_contracts::{ChangedFile, FileDiffResponse};
use eos_core::BoxFuture;
use eos_core::git::{DiffStat, GitDiffs};
use eos_domain::git::changes::{
    PATCH_MAX_BYTES, merge_changes, merge_changes_with_base, parse_name_status_z, parse_numstat_z, parse_porcelain_z,
    says_binary, truncate_patch,
};

use crate::Git;
use crate::info::is_managed;
use crate::records::{FIRST_PARENT_DIFF, IGNORE_DIRTY_SUBMODULES, parse_short_stat};
use crate::run::{Limits, PATCH_CAP, parse_int};

fn no_patch(path: &str) -> FileDiffResponse {
    FileDiffResponse { path: path.to_owned(), patch: String::new(), binary: false, truncated: false }
}

fn as_file_diff(path: &str, out: &str) -> FileDiffResponse {
    if says_binary(out) {
        return FileDiffResponse { binary: true, ..no_patch(path) };
    }
    let (patch, truncated) = truncate_patch(out, PATCH_MAX_BYTES);
    FileDiffResponse { path: path.to_owned(), patch, binary: false, truncated }
}

impl Git {
    async fn patch(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        self.run_with(cwd, args, &[], Limits { cap: PATCH_CAP, timeout: None }).await.ok().map(|ran| ran.text())
    }

    async fn changed_files_of(&self, cwd: &Path, base: Option<&str>) -> Option<Vec<ChangedFile>> {
        let status = self.text(cwd, &["status", "--porcelain=v1", "-z", "-uall", IGNORE_DIRTY_SUBMODULES]).await?;
        let status = parse_porcelain_z(&status);
        if let Some(base) = base {
            let names = self.text(cwd, &["diff", "--name-status", "-z", IGNORE_DIRTY_SUBMODULES, base]).await?;
            let counts = self.text(cwd, &["diff", "--numstat", "-z", IGNORE_DIRTY_SUBMODULES, base]).await?;
            return Some(merge_changes_with_base(&parse_name_status_z(&names), &status, &parse_numstat_z(&counts)));
        }
        // No commit yet: the status entries alone, without line counts.
        let counts =
            self.text(cwd, &["diff", "--numstat", "-z", IGNORE_DIRTY_SUBMODULES, "HEAD"]).await.unwrap_or_default();
        Some(merge_changes(&status, &parse_numstat_z(&counts)))
    }

    async fn file_diff_of(&self, cwd: &Path, path: &str, old_path: Option<&str>, base: Option<&str>) -> Option<String> {
        // The status of this one path tells tracked from untracked (a staged
        // delete is tracked, though `ls-files` would not list it).
        let status = self.text(cwd, &["status", "--porcelain=v1", "-z", "--", path]).await?;
        if status.starts_with("??") {
            // `--no-index` exits 1 when the files differ: the patch is still on stdout.
            return match self.run(cwd, &["diff", "--no-index", "--", "/dev/null", path]).await {
                Ok(ran) => Some(ran.text()),
                Err(failed) if !failed.stdout.is_empty() => Some(failed.stdout),
                Err(_) => None,
            };
        }
        let mut args = vec!["diff", IGNORE_DIRTY_SUBMODULES, base.unwrap_or("HEAD"), "--", path];
        args.extend(old_path.filter(|p| !p.is_empty()));
        self.text(cwd, &args).await
    }
}

impl GitDiffs for Git {
    fn diff_short_stat<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, DiffStat> {
        Box::pin(async move {
            // The two halves fail apart: with no commit yet the diff errors,
            // and the untracked files still count.
            let mut stat = self
                .text(cwd, &["diff", "--shortstat", IGNORE_DIRTY_SUBMODULES, base.unwrap_or("HEAD")])
                .await
                .map(|out| parse_short_stat(out.trim()))
                .unwrap_or_default();
            // `git diff` never lists untracked files; a new file is a change too.
            if let Some(untracked) = self.text(cwd, &["ls-files", "--others", "--exclude-standard"]).await {
                stat.files += untracked.split('\n').filter(|l| !l.is_empty() && !is_managed(l)).count() as u32;
            }
            stat
        })
    }

    fn changed_files<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, Vec<ChangedFile>> {
        Box::pin(async move { self.changed_files_of(cwd, base).await.unwrap_or_default() })
    }

    fn file_diff<'a>(
        &'a self,
        cwd: &'a Path,
        path: &'a str,
        old_path: Option<&'a str>,
        base: Option<&'a str>,
    ) -> BoxFuture<'a, FileDiffResponse> {
        Box::pin(async move {
            match self.file_diff_of(cwd, path, old_path, base).await {
                Some(out) => as_file_diff(path, &out),
                None => no_patch(path),
            }
        })
    }

    fn full_diff<'a>(&'a self, cwd: &'a Path, base: Option<&'a str>) -> BoxFuture<'a, Option<String>> {
        Box::pin(
            self.patch_owned(cwd, vec!["diff".into(), IGNORE_DIRTY_SUBMODULES.into(), base.unwrap_or("HEAD").into()]),
        )
    }

    fn commit_patch<'a>(&'a self, cwd: &'a Path, sha: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(self.patch_owned(
            cwd,
            vec![
                "show".into(),
                sha.into(),
                FIRST_PARENT_DIFF.into(),
                "--format=".into(),
                "--patch".into(),
                IGNORE_DIRTY_SUBMODULES.into(),
            ],
        ))
    }

    fn commit_file_diff<'a>(
        &'a self,
        cwd: &'a Path,
        sha: &'a str,
        path: &'a str,
        old_path: Option<&'a str>,
    ) -> BoxFuture<'a, FileDiffResponse> {
        Box::pin(async move {
            let mut args = vec!["show", sha, FIRST_PARENT_DIFF, "--format=", "--", path];
            args.extend(old_path.filter(|p| !p.is_empty()));
            match self.text(cwd, &args).await {
                Some(out) => as_file_diff(path, &out),
                None => no_patch(path),
            }
        })
    }

    fn blob_size_at_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str, path: &'a str) -> BoxFuture<'a, Option<u64>> {
        Box::pin(async move {
            let out = self.text(cwd, &["cat-file", "-s", &format!("{rev}:{path}")]).await?;
            parse_int(out.trim()).and_then(|n| u64::try_from(n).ok())
        })
    }

    fn blob_at_ref<'a>(&'a self, cwd: &'a Path, rev: &'a str, path: &'a str) -> BoxFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            let spec = format!("{rev}:{path}");
            let limits = Limits { cap: PATCH_CAP, timeout: None };
            self.run_with(cwd, &["cat-file", "blob", &spec], &[], limits).await.ok().map(|ran| ran.stdout)
        })
    }

    fn conflict_file_content<'a>(&'a self, cwd: &'a Path, path: &'a str) -> BoxFuture<'a, String> {
        // The file on disk carries the markers git wrote; the index has no
        // merged entry for a path in conflict.
        let file = cwd.join(path);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || std::fs::read(file).map(|b| String::from_utf8_lossy(&b).into_owned()))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default()
        })
    }

    fn stage_content<'a>(&'a self, cwd: &'a Path, path: &'a str, stage: u8) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.text(cwd, &["show", &format!(":{stage}:{path}")]).await })
    }
}

impl Git {
    async fn patch_owned(&self, cwd: &Path, args: Vec<String>) -> Option<String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.patch(cwd, &args).await
    }
}
