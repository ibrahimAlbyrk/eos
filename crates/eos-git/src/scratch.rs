//! The folders of chats started without one.
//!
//! Each is `<root>/<worker id>`, a git repository with one empty commit: a
//! sub-agent's worktree needs a HEAD to fork from and the changes panel needs
//! one to compare against.

use std::fs;
use std::path::{Path, PathBuf};

use eos_core::agent::ScratchFolders;
use eos_core::{BoxFuture, Error};

use crate::Git;
use crate::run::Limits;

/// A fixed identity: the first commit must not depend on the user's git configuration.
const COMMIT_ENV: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "eos"),
    ("GIT_AUTHOR_EMAIL", "eos@local"),
    ("GIT_COMMITTER_NAME", "eos"),
    ("GIT_COMMITTER_EMAIL", "eos@local"),
];

/// Scratch folders on the local disk.
#[derive(Debug, Clone)]
pub struct ScratchRepos {
    git: Git,
    /// The parent of every scratch folder.
    root: PathBuf,
    /// Where Claude Code keeps what it knows per folder (transcripts, memory).
    claude_projects: PathBuf,
}

/// The name Claude Code files a folder under: every character outside
/// `[a-zA-Z0-9_-]` becomes a dash.
fn encode_cwd(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

fn subdirs(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

impl ScratchRepos {
    pub fn new(git: Git, root: impl Into<PathBuf>, claude_projects: impl Into<PathBuf>) -> Self {
        Self { git, root: root.into(), claude_projects: claude_projects.into() }
    }

    async fn init(&self, dir: &Path) -> Result<(), Error> {
        let failed = |e: crate::run::Failed| Error::storage(format!("scratch folder: {}", e.first_line()));
        self.git.run(dir, &["init", "-q"]).await.map_err(failed)?;
        let commit =
            ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", "Eos scratch folder"];
        self.git.run_with(dir, &commit, &COMMIT_ENV, Limits::default()).await.map_err(failed)?;
        Ok(())
    }
}

impl ScratchFolders for ScratchRepos {
    fn create<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            let dir = self.root.join(id);
            fs::create_dir_all(&dir).map_err(|e| Error::storage(format!("scratch folder: {e}")))?;
            if let Err(e) = self.init(&dir).await {
                let _ = fs::remove_dir_all(&dir);
                return Err(e);
            }
            Ok(dir.to_string_lossy().into_owned())
        })
    }

    fn remove<'a>(&'a self, dir: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let dir = PathBuf::from(dir);
            if dir.parent() != Some(self.root.as_path()) {
                return;
            }
            // Claude Code files a folder under its real path: resolved while the folder is still there.
            let encoded = encode_cwd(&fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone()));
            let projects = self.claude_projects.clone();
            let removed = tokio::task::spawn_blocking(move || {
                let _ = fs::remove_dir_all(&dir);
                // The agent's own data, and its sub-agents' (their worktrees sit inside the folder).
                let worktrees = format!("{encoded}--eos-worktrees-");
                for name in subdirs(&projects) {
                    if name == encoded || name.starts_with(&worktrees) {
                        let _ = fs::remove_dir_all(projects.join(name));
                    }
                }
            });
            let _ = removed.await;
        })
    }

    fn list(&self) -> Vec<String> {
        subdirs(&self.root).into_iter().map(|name| self.root.join(name).to_string_lossy().into_owned()).collect()
    }
}
