//! Throwaway repositories under the system's temporary folder. Nothing here
//! touches a repository that exists already.

#![allow(dead_code, clippy::missing_panics_doc)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use eos_core::SystemClock;
use eos_git::Git;
use eos_kit_proc::{ProcessTrees, Runner};

pub(crate) fn adapter() -> Git {
    let trees = ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
    Git::new(Runner::new(trees), Arc::new(SystemClock))
}

/// A temporary folder by its real path (git prints real paths).
pub(crate) struct Dir {
    _keep: tempfile::TempDir,
    pub(crate) path: PathBuf,
}

impl Dir {
    pub(crate) fn new(prefix: &str) -> Self {
        let keep = tempfile::Builder::new().prefix(prefix).tempdir().expect("a temporary folder");
        let path = fs::canonicalize(keep.path()).expect("its real path");
        Self { _keep: keep, path }
    }

    pub(crate) fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub(crate) fn write(&self, name: &str, content: impl AsRef<[u8]>) {
        write(&self.path, name, content);
    }

    pub(crate) fn read(&self, name: &str) -> String {
        fs::read_to_string(self.join(name)).expect("the file")
    }
}

pub(crate) fn write(dir: &Path, name: &str, content: impl AsRef<[u8]>) {
    let file = dir.join(name);
    fs::create_dir_all(file.parent().expect("a parent")).expect("the folders");
    fs::write(file, content).expect("the file");
}

/// Runs git in `cwd`; returns its exit code and stdout + stderr.
pub(crate) fn git(cwd: &Path, args: &[&str]) -> (i32, String) {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git runs");
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.code().unwrap_or(-1), text)
}

pub(crate) fn git_ok(cwd: &Path, args: &[&str]) -> String {
    let (code, out) = git(cwd, args);
    assert_eq!(code, 0, "git {args:?} failed: {out}");
    out
}

/// A new repository on branch `main` with an identity and signing off.
pub(crate) fn init_repo(prefix: &str) -> Dir {
    let dir = Dir::new(prefix);
    git_ok(&dir.path, &["init", "-q", "-b", "main"]);
    configure(&dir.path);
    dir
}

pub(crate) fn configure(repo: &Path) {
    git_ok(repo, &["config", "user.email", "t@t.t"]);
    git_ok(repo, &["config", "user.name", "tester"]);
    git_ok(repo, &["config", "commit.gpgsign", "false"]);
}

pub(crate) fn commit_file(repo: &Path, name: &str, content: &str, message: &str) {
    write(repo, name, content);
    git_ok(repo, &["add", "-A"]);
    git_ok(repo, &["commit", "-q", "-m", message]);
}

pub(crate) fn head(repo: &Path) -> String {
    git_ok(repo, &["rev-parse", "HEAD"]).trim().to_owned()
}
