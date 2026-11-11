//! A shallow clone through the `git` program, for a plugin published as a
//! repository.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use eos_core::plugin::PluginCloner;
use eos_core::{BoxFuture, Error};
use eos_kit_proc::{Command, Env, Runner};

const TIMEOUT: Duration = Duration::from_secs(60);

/// Runs `git clone` so that nothing from the repository — or from the user's
/// git settings — runs with it:
///
/// - hooks point at an empty folder, and so does the template, even if the
///   user's configuration names others;
/// - links in the repository are written as plain files;
/// - no submodules, no tags, one branch, one commit deep;
/// - only the allowed transport, and never a prompt for credentials.
#[derive(Debug, Clone)]
pub struct GitCloner {
    runner: Runner,
    git: OsString,
    protocols: String,
}

impl GitCloner {
    /// Clones over https only.
    pub fn new(runner: Runner) -> Self {
        Self { runner, git: "git".into(), protocols: "https".to_owned() }
    }

    /// Another `git` than the one on the `PATH`.
    pub fn program(mut self, git: impl Into<OsString>) -> Self {
        self.git = git.into();
        self
    }

    /// The transports git may use (`GIT_ALLOW_PROTOCOL`): tests clone local repositories.
    pub fn allow_protocols(mut self, protocols: impl Into<String>) -> Self {
        self.protocols = protocols.into();
        self
    }

    fn command(&self) -> Command {
        Command::new(&self.git)
            .env(Env::inherit().set("GIT_TERMINAL_PROMPT", "0").set("GIT_ALLOW_PROTOCOL", &self.protocols))
            .timeout(TIMEOUT)
    }
}

impl PluginCloner for GitCloner {
    fn shallow_clone<'a>(
        &'a self,
        url: &'a str,
        reference: Option<&'a str>,
        dir: &'a Path,
    ) -> BoxFuture<'a, Result<String, Error>> {
        Box::pin(async move {
            let failed = |why: &str| {
                let at = reference.map(|r| format!(" at {r}")).unwrap_or_default();
                Error::Validation(format!("couldn't clone {url}{at}: {}", why.trim()))
            };
            // Removed when this returns, whatever happened.
            let nothing = tempfile::Builder::new().prefix("eos-plugin-hooks-").tempdir().map_err(Error::storage)?;
            let mut hooks = OsString::from("core.hooksPath=");
            hooks.push(nothing.path());
            let mut template = OsString::from("--template=");
            template.push(nothing.path());

            let mut clone = self
                .command()
                .arg("-c")
                .arg(hooks)
                .args(["-c", "core.symlinks=false"])
                .args(["clone", "--depth", "1", "--single-branch", "--no-tags"])
                .arg(template);
            if let Some(reference) = reference {
                clone = clone.args(["--branch", reference]);
            }
            let out = self.runner.run(clone.arg("--").arg(url).arg(dir)).await.map_err(|e| failed(&e.to_string()))?;
            if out.timed_out {
                return Err(failed(&format!("no answer within {} s", TIMEOUT.as_secs())));
            }
            if !out.success() {
                return Err(failed(&out.stderr_text()));
            }

            let head = self.command().arg("-C").arg(dir).args(["rev-parse", "HEAD"]);
            let out = self.runner.run(head).await.map_err(|e| failed(&e.to_string()))?;
            if !out.success() {
                return Err(failed(&out.stderr_text()));
            }
            let commit = out.stdout_text().trim().to_owned();

            let repository = dir.join(".git");
            tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(&repository) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::storage(e)),
                _ => Ok(()),
            })
            .await
            .map_err(Error::storage)??;
            Ok(commit)
        })
    }
}
