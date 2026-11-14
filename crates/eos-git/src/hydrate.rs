//! A fresh worktree holds tracked files only: no `node_modules`, no `.env`,
//! so an agent could not build or test on its first turn. The source
//! checkout's dependency folders are cloned in (`cp -c`: instant and nearly
//! free on APFS), with a size-capped plain copy elsewhere.
//!
//! Every candidate must be ignored by git in the source: a path git tracks or
//! would list as untracked would leave the worktree dirty forever. A linked
//! `node_modules` is skipped, since it resolves straight back into the
//! user's checkout.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::Git;
use crate::run::{Limits, parse_int};

/// Folder levels searched for `node_modules` and `.env` files.
const MAX_SCAN_DEPTH: usize = 4;
/// The plain-copy fallback's cap, in KiB (1 GiB). A clone has no cap.
const PLAIN_COPY_CAP_KB: i64 = 1024 * 1024;

#[derive(Debug, Default)]
struct Targets {
    node_modules: Vec<PathBuf>,
    env_files: Vec<PathBuf>,
}

fn is_env_file(name: &str) -> bool {
    name == ".env" || name.strip_prefix(".env.").is_some_and(|rest| !rest.is_empty() && !rest.contains('\n'))
}

fn find_targets(dir: &Path, depth: usize, out: &mut Targets) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if name == ".git" || name == ".eos" {
                continue;
            }
            if name == "node_modules" {
                out.node_modules.push(entry.path());
            } else if depth < MAX_SCAN_DEPTH {
                find_targets(&entry.path(), depth + 1, out);
            }
        } else if kind.is_file() && is_env_file(&name) {
            out.env_files.push(entry.path());
        }
    }
}

async fn copy_into(git: &Git, src: &Path, dst: &Path) {
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let args = |flag: &str| -> Vec<OsString> { vec![flag.into(), src.into(), dst.into()] };
    // A clone first; `cp -c` fails at once where the filesystem cannot clone.
    if git.exec("cp", args("-Rc"), None, &[], Limits::default()).await.is_ok() {
        return;
    }
    let size_kb = match git.exec("du", vec!["-sk".into(), src.into()], None, &[], Limits::default()).await {
        Ok(ran) => parse_int(ran.text().split('\t').next().unwrap_or_default()).unwrap_or(i64::MAX),
        Err(_) => i64::MAX,
    };
    if size_kb <= PLAIN_COPY_CAP_KB {
        let _ = git.exec("cp", args("-R"), None, &[], Limits::default()).await;
    }
}

/// Copies the source's ignored `node_modules` folders (and, with
/// `include_env_files`, its `.env*` files) into the worktree. Never fails.
pub(crate) async fn hydrate_worktree(git: &Git, repo_root: &Path, worktree_dir: &Path, include_env_files: bool) {
    let root = repo_root.to_owned();
    let found = tokio::task::spawn_blocking(move || {
        let mut targets = Targets::default();
        find_targets(&root, 1, &mut targets);
        targets
    })
    .await
    .unwrap_or_default();
    let mut candidates = found.node_modules;
    if include_env_files {
        candidates.extend(found.env_files);
    }
    for src in candidates {
        let Ok(rel) = src.strip_prefix(repo_root) else { continue };
        let ignored = git
            .exec("git", vec!["check-ignore".into(), "-q".into(), rel.into()], Some(repo_root), &[], Limits::default())
            .await
            .is_ok();
        let dst = worktree_dir.join(rel);
        if ignored && !dst.exists() {
            copy_into(git, &src, &dst).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_files_are_dot_env_with_an_optional_suffix() {
        for yes in [".env", ".env.local", ".env.production.local"] {
            assert!(is_env_file(yes), "{yes}");
        }
        for no in [".env.", ".environment", "env", "a.env"] {
            assert!(!is_env_file(no), "{no}");
        }
    }

    #[test]
    fn the_scan_stops_at_node_modules_and_skips_git_and_eos() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();
        for path in [
            "node_modules/pkg/node_modules/inner/x.js",
            "packages/app/node_modules/dep/index.js",
            ".git/node_modules/x",
            ".eos/worktrees/w/node_modules/x",
            "a/b/c/d/node_modules/too-deep",
        ] {
            let file = root.join(path);
            fs::create_dir_all(file.parent().expect("parent")).expect("dirs");
            fs::write(file, "x").expect("write");
        }
        fs::write(root.join(".env"), "A=1").expect("write");
        fs::write(root.join("packages/app/.env.local"), "B=2").expect("write");
        let mut targets = Targets::default();
        find_targets(root, 1, &mut targets);
        assert_eq!(targets.node_modules, [root.join("node_modules"), root.join("packages/app/node_modules")]);
        assert_eq!(targets.env_files, [root.join(".env"), root.join("packages/app/.env.local")]);
    }
}
