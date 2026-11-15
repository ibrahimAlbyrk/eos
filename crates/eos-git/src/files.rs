use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_core::BoxFuture;
use eos_core::git::{CandidateFiles, GitDirs};
use eos_domain::fs_ignore::is_ignored;

use crate::Git;
use crate::run::Limits;

/// A listing of every file of a large repository.
const LIST_CAP: usize = 10 * 1024 * 1024;
/// How long the listing of ignored folders may take.
const IGNORED_TIMEOUT: Duration = Duration::from_secs(30);
/// Folders asked about per working tree; past it the rest stay watched.
const IGNORED_ASKED: usize = 2048;
/// Folders named on one `git check-ignore` command line.
const IGNORED_CHUNK: usize = 256;
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

/// The folders of a working tree that its own rules (its `.gitignore` files and
/// `info/exclude`) ignore by name, relative to its top folder: whatever is made
/// in one later is ignored too. git lists a folder whole when nothing in it is
/// tracked or let back in, also when only what it holds today is ignored
/// (`logs/` holding only `a.log`), so each listed folder is asked about itself;
/// one whose name cannot be passed and read back plainly is left out. The
/// user's global rules are left out: nothing watches them change. `None` when
/// git fails.
pub async fn ignored_folders(git: &Git, dirs: &GitDirs) -> Option<Vec<PathBuf>> {
    let exclude = dirs.common_dir.join("info").join("exclude");
    let from = exclude.is_file().then(|| exclude.to_str().map(|path| format!("--exclude-from={path}"))).flatten();
    let mut args = vec!["ls-files", "-z", "--others", "--ignored", "--directory", "--exclude-per-directory=.gitignore"];
    if let Some(from) = &from {
        args.push(from);
    }
    let limits = Limits { timeout: Some(IGNORED_TIMEOUT), ..Limits::default() };
    let ran = git.run_with(&dirs.toplevel, &args, &[], limits).await.ok()?;
    let listed: Vec<&str> = ran
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok()?.strip_suffix('/'))
        .filter(|folder| !folder.is_empty() && is_plain(folder))
        .take(IGNORED_ASKED)
        .collect();
    let mut folders = Vec::new();
    for chunk in listed.chunks(IGNORED_CHUNK) {
        folders.extend(ignored_by_name(git, &dirs.toplevel, chunk).await?.into_iter().map(PathBuf::from));
    }
    Some(folders)
}

/// A name `git check-ignore` prints back as it was given (with
/// `core.quotePath` off, only these characters are quoted).
fn is_plain(path: &str) -> bool {
    !path.chars().any(|c| c.is_control() || c == '"' || c == '\\')
}

/// Which of `folders` a rule ignores by their own name, or through a folder
/// above them. Asked without a trailing `/`: with one, `/x/*` and a rule inside
/// the folder would match the folder itself.
async fn ignored_by_name<'a>(git: &Git, top: &Path, folders: &[&'a str]) -> Option<Vec<&'a str>> {
    let mut args = vec!["check-ignore", "--"];
    args.extend_from_slice(folders);
    // As the listing: the repository's own rules only, and names printed as given.
    let env = [
        ("GIT_CONFIG_COUNT", "2"),
        ("GIT_CONFIG_KEY_0", "core.excludesFile"),
        ("GIT_CONFIG_VALUE_0", "/dev/null"),
        ("GIT_CONFIG_KEY_1", "core.quotePath"),
        ("GIT_CONFIG_VALUE_1", "false"),
    ];
    let limits = Limits { timeout: Some(IGNORED_TIMEOUT), ..Limits::default() };
    let printed = match git.run_with(top, &args, &env, limits).await {
        Ok(ran) => ran.text(),
        // Nothing of them is ignored.
        Err(failed) if failed.code == Some(1) && failed.stdout.is_empty() => return Some(Vec::new()),
        Err(_) => return None,
    };
    let printed: HashSet<&str> = printed.lines().collect();
    Some(folders.iter().copied().filter(|folder| printed.contains(folder)).collect())
}

impl CandidateFiles for Git {
    fn list<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Arc<[String]>> {
        Box::pin(async move { list_candidate_files(self, root).await.into() })
    }
}
