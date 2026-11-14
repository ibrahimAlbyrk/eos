//! Which `git` binary is started.
//!
//! On a Mac the only `git` on `PATH` is usually `/usr/bin/git`, Apple's
//! `xcrun` shim: it looks up the developer folder and starts the real git,
//! which roughly doubles the cost of every command. The real binary is found
//! once from `git --exec-path` (`<prefix>/libexec/git-core` → `<prefix>/bin/git`)
//! and started by its path from then on. When it cannot be found, `git` on
//! `PATH` is started as before; when the path stops working (an Xcode update
//! moved it), it is looked up again.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use eos_kit_fs::path::normalize;
use eos_kit_proc::{Command, Overflow, Runner};

/// What is started when no better path is known.
const ON_PATH: &str = "git";

/// The `git` program, resolved on first use. Shared by every clone of a `Git`.
#[derive(Default)]
pub(crate) struct Program {
    resolved: RwLock<Option<OsString>>,
    /// One lookup at a time.
    resolving: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Program").field("resolved", &self.current()).finish()
    }
}

impl Program {
    fn current(&self) -> Option<OsString> {
        self.resolved.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The program to start.
    pub(crate) async fn get(&self, runner: &Runner) -> OsString {
        if let Some(program) = self.current() {
            return program;
        }
        let _one = self.resolving.lock().await;
        if let Some(program) = self.current() {
            return program;
        }
        let program = resolve(runner).await;
        *self.resolved.write().unwrap_or_else(|p| p.into_inner()) = Some(program.clone());
        program
    }

    /// `program` could not be started: it is looked up again next time.
    /// Returns whether that changes anything (it was a resolved path).
    pub(crate) fn forget(&self, program: &OsStr) -> bool {
        let mut resolved = self.resolved.write().unwrap_or_else(|p| p.into_inner());
        if program == OsStr::new(ON_PATH) || resolved.as_deref() != Some(program) {
            return false;
        }
        *resolved = None;
        true
    }
}

/// The real binary next to git's own helpers, or `git` on `PATH`.
async fn resolve(runner: &Runner) -> OsString {
    let asked =
        Command::new(ON_PATH).arg("--exec-path").timeout(Duration::from_secs(10)).max_output(64 * 1024, Overflow::Fail);
    let exec_path = match runner.run(asked).await {
        Ok(out) if out.success() => out.stdout_text().trim().to_owned(),
        _ => String::new(),
    };
    match binary_beside(Path::new(&exec_path)) {
        Some(path) => path.into_os_string(),
        None => OsString::from(ON_PATH),
    }
}

/// `<prefix>/libexec/git-core` → `<prefix>/bin/git`, else the `git` inside
/// `git-core`, whichever is a file.
fn binary_beside(exec_path: &Path) -> Option<PathBuf> {
    if !exec_path.is_absolute() {
        return None;
    }
    let name = format!("git{}", std::env::consts::EXE_SUFFIX);
    [normalize(&exec_path.join("../../bin").join(&name)), exec_path.join(&name)].into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_binary_is_found_beside_the_helpers() {
        let root = tempfile::tempdir().expect("a folder");
        let core = root.path().join("libexec/git-core");
        std::fs::create_dir_all(&core).expect("folders");
        assert_eq!(binary_beside(&core), None);
        let name = format!("git{}", std::env::consts::EXE_SUFFIX);
        std::fs::write(core.join(&name), "").expect("the helper copy");
        assert_eq!(binary_beside(&core), Some(core.join(&name)));
        std::fs::create_dir_all(root.path().join("bin")).expect("bin");
        std::fs::write(root.path().join("bin").join(&name), "").expect("the binary");
        assert_eq!(binary_beside(&core), Some(normalize(&root.path().join("bin").join(&name))));
        assert_eq!(binary_beside(Path::new("relative/git-core")), None);
    }

    #[test]
    fn only_a_resolved_path_is_forgotten() {
        let program = Program::default();
        assert!(!program.forget(OsStr::new("git")));
        *program.resolved.write().expect("lock") = Some(OsString::from("/x/bin/git"));
        assert!(!program.forget(OsStr::new("/y/bin/git")));
        assert!(program.forget(OsStr::new("/x/bin/git")));
        assert_eq!(program.current(), None);
    }
}
