//! The `script` form: one confined program per call.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_core::capability::{
    ActionError, ActionRunner, ConfineError, ConfineReport, ConfineSpec, Confinement, FailureKind, Package, Violation,
};
use eos_core::{BoxFuture, Ids};
use eos_domain::capability::manifest::{Action, Form};
use eos_kit_proc::{Command, Env, Overflow, Runner};
use serde_json::Value;
use zeroize::Zeroizing;

/// The most a script's answer may hold; a longer one fails the call.
pub const OUTPUT_MAX_BYTES: usize = 1024 * 1024;

/// What a confined program finds on its `PATH`: the system's own tools.
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Runs `script` packages from `<root>/<id>/<version>/`, each writing its
/// `<root>/<id>/data/`, each call in a fresh folder under `temp`.
pub struct ScriptHost {
    root: PathBuf,
    temp: PathBuf,
    confinement: Arc<dyn Confinement>,
    runner: Runner,
    ids: Arc<dyn Ids>,
}

impl std::fmt::Debug for ScriptHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptHost").field("root", &self.root).finish_non_exhaustive()
    }
}

impl ScriptHost {
    /// `root` is the data folder's `capabilities`; `temp` a folder of Eos's
    /// own scratch area.
    pub fn new(
        root: impl Into<PathBuf>,
        temp: impl Into<PathBuf>,
        confinement: Arc<dyn Confinement>,
        runner: Runner,
        ids: Arc<dyn Ids>,
    ) -> Self {
        Self { root: root.into(), temp: temp.into(), confinement, runner, ids }
    }

    fn package_dir(&self, package: &Package) -> PathBuf {
        self.root.join(&package.id).join(&package.version)
    }

    fn data_dir(&self, package: &Package) -> PathBuf {
        self.root.join(&package.id).join("data")
    }
}

impl ActionRunner for ScriptHost {
    fn run<'a>(
        &'a self,
        package: &'a Package,
        action: &'a str,
        input: Value,
        env: Vec<(String, Zeroizing<String>)>,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        Box::pin(async move {
            let Some(declared) = package.manifest.actions.iter().find(|a| a.name == action) else {
                return Err(ActionError::NotFound);
            };
            if package.manifest.form != Form::Script {
                return Err(code_failed(&package.id, action, "not a script package"));
            }
            let tmpdir = self.temp.join(format!("call-{}", self.ids.uuid()));
            let answer = self.call(package, declared, input, env, timeout, &tmpdir).await;
            if let Err(error) = tokio::fs::remove_dir_all(&tmpdir).await
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(capability = %package.id, action, %error, "a call's temp folder stays");
            }
            answer
        })
    }

    // A script holds nothing between calls.
    fn stop<'a>(&'a self, _id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }
}

impl ScriptHost {
    async fn call(
        &self,
        package: &Package,
        action: &Action,
        input: Value,
        env: Vec<(String, Zeroizing<String>)>,
        timeout: Duration,
        tmpdir: &Path,
    ) -> Result<Value, ActionError> {
        let (id, name) = (package.id.as_str(), action.name.as_str());
        let Some((program, args)) = action.run.split_first() else {
            return Err(code_failed(id, name, "no program to run"));
        };
        // Paths reach the sandbox as written: one it cannot name confines nothing.
        if !Path::new(program).is_absolute() {
            return Err(code_failed(id, name, "its program is no absolute path"));
        }
        if package.manifest.reach.files_read.iter().any(|path| !Path::new(path).is_absolute()) {
            return Err(code_failed(id, name, "a file it reads is no absolute path"));
        }
        let (package_dir, data) = (self.package_dir(package), self.data_dir(package));
        if let Err(error) = tokio::fs::create_dir_all(&data).await {
            tracing::warn!(capability = id, action = name, %error, "a capability's data folder could not be made");
            return Err(ActionError::Failed { kind: FailureKind::Internal });
        }
        let mut variables = vec![("PATH".to_owned(), SYSTEM_PATH.to_owned()), ("HOME".to_owned(), data_text(&data))];
        // Secrets go in the variables their manifest names, and nowhere else.
        variables.extend(env.iter().map(|(name, value)| (name.clone(), value.as_str().to_owned())));
        let spec = ConfineSpec {
            program: PathBuf::from(program),
            args: args.to_vec(),
            cwd: package_dir.clone(),
            env: variables,
            package: package_dir.clone(),
            data,
            tmpdir: tmpdir.to_owned(),
            reach: package.manifest.reach.clone(),
            audit: false,
        };
        let confined = self.confinement.command(spec).await.map_err(|error| match error {
            ConfineError::Unavailable => {
                tracing::warn!(capability = id, action = name, "the sandbox does not work: the action did not run");
                ActionError::NotReady(SANDBOX_UNAVAILABLE.into())
            }
            ConfineError::Failed(_) => code_failed(id, name, "it could not be confined"),
        })?;
        let mut environment = Env::empty();
        for (variable, value) in &confined.env {
            environment = environment.set(variable, value);
        }
        let body = serde_json::to_vec(&input).map_err(|_| ActionError::Failed { kind: FailureKind::Internal })?;
        let command = Command::new(&confined.program)
            .args(&confined.args)
            .cwd(&package_dir)
            .env(environment)
            .stdin(body)
            .timeout(timeout)
            .max_output(OUTPUT_MAX_BYTES, Overflow::Fail);
        let ran = self.runner.run(command).await;
        report(id, name, confined.guard.finish().await);
        let output = match ran {
            Ok(output) => output,
            Err(eos_kit_proc::Error::OutputTooLarge { .. }) => return Err(code_failed(id, name, "it said too much")),
            Err(_) => return Err(code_failed(id, name, "it could not start")),
        };
        if output.timed_out {
            tracing::info!(capability = id, action = name, "a script action ran past its deadline");
            return Err(ActionError::Timeout);
        }
        if !output.success() {
            tracing::info!(capability = id, action = name, code = ?output.exit_code, "a script action failed");
            return Err(ActionError::Failed { kind: FailureKind::Code });
        }
        serde_json::from_slice(&output.stdout).map_err(|_| {
            tracing::info!(capability = id, action = name, "a script action's answer was no JSON");
            ActionError::Failed { kind: FailureKind::Output }
        })
    }
}

/// The state code an action is refused with while the sandbox does not work.
pub const SANDBOX_UNAVAILABLE: &str = "sandbox_unavailable";

fn data_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn code_failed(id: &str, action: &str, why: &'static str) -> ActionError {
    tracing::warn!(capability = id, action, why, "a script action did not run");
    ActionError::Failed { kind: FailureKind::Code }
}

/// Logs what the sandbox denied, by kind: what was reached is the
/// capability's business, and a path or host can carry the user's data.
fn report(id: &str, action: &str, report: ConfineReport) {
    if report.violations.is_empty() && report.more == 0 {
        if !report.watched {
            tracing::debug!(capability = id, action, "the sandbox's own denials were not read");
        }
        return;
    }
    let count = |pick: fn(&Violation) -> bool| report.violations.iter().filter(|v| pick(v)).count();
    tracing::warn!(
        capability = id,
        action,
        file_reads = count(|v| matches!(v, Violation::FileRead { .. })),
        file_writes = count(|v| matches!(v, Violation::FileWrite { .. })),
        network = count(|v| matches!(v, Violation::Network { .. })),
        exec = count(|v| matches!(v, Violation::Exec { .. })),
        mach = count(|v| matches!(v, Violation::Mach { .. })),
        apple_events = count(|v| matches!(v, Violation::AppleEvent { .. })),
        more = report.more,
        "the sandbox denied a capability something"
    );
}
