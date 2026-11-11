use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_core::BoxFuture;
use eos_core::git::CandidateFiles;
use eos_domain::fs_ignore::is_ignored;

use crate::Git;
use crate::run::Limits;

/// A listing of every file of a large repository.
const LIST_CAP: usize = 10 * 1024 * 1024;
/// Folder levels walked where there is no repository.
const WALK_DEPTH: usize = 5;
/// Files a walk gives before it stops.
const WALK_MAX_FILES: usize = 100_000;

fn walk(dir: &Path, rel: &str, depth_left: usize, out: &mut Vec<String>) {
    if depth_left == 0 || out.len() >= WALK_MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<(String, bool)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            if name.starts_with('.') || is_ignored(&name) {
                return None;
            }
            Some((name, entry.file_type().ok()?.is_dir()))
        })
        .collect();
    // The order a folder is read in today: by name, byte by byte.
    entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    for (name, is_dir) in entries {
        let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if is_dir {
            walk(&dir.join(&name), &path, depth_left - 1, out);
        } else if out.len() < WALK_MAX_FILES {
            out.push(path);
        }
    }
}

fn walk_files(root: PathBuf) -> Vec<String> {
    let mut out = Vec::new();
    walk(&root, "", WALK_DEPTH, &mut out);
    out
}

/// The files of `cwd` that search and the symbol index consider: tracked
/// first, then untracked ones git does not ignore (one `--cached --others`
/// call would list the untracked first and reorder results). Without a
/// repository: a walk five levels deep that skips hidden and ignored names.
pub async fn list_candidate_files(git: &Git, cwd: &Path) -> Vec<String> {
    let ls = |extra: &'static [&'static str]| async move {
        let mut args = vec!["ls-files".into(), "-z".into()];
        args.extend(extra.iter().map(Into::into));
        git.exec("git", args, Some(cwd), &[], Limits { cap: LIST_CAP, timeout: None }).await
    };
    let (tracked, untracked) = tokio::join!(ls(&[]), ls(&["--others", "--exclude-standard"]));
    let (Ok(tracked), Ok(untracked)) = (tracked, untracked) else {
        let root = cwd.to_owned();
        return tokio::task::spawn_blocking(move || walk_files(root)).await.unwrap_or_default();
    };
    let (tracked, untracked) = (tracked.text(), untracked.text());
    let mut seen = HashSet::new();
    tracked
        .split('\0')
        .chain(untracked.split('\0'))
        .filter(|path| !path.is_empty() && seen.insert(*path))
        .map(str::to_owned)
        .collect()
}

impl CandidateFiles for Git {
    fn list<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Arc<[String]>> {
        Box::pin(async move { list_candidate_files(self, root).await.into() })
    }
}
