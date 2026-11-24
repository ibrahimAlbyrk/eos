//! The `script` form: one confined program per call.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_core::capability::{ActionError, ActionRunner, Confinement, FailureKind, Package};
use eos_core::{BoxFuture, Ids};
use eos_domain::capability::manifest::{Action, Form};
use eos_kit_proc::{Command, Env, Overflow, Runner};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::confined::{Layout, code_failed, remove_temp, report};

/// The most a script's answer may hold; a longer one fails the call.
pub const OUTPUT_MAX_BYTES: usize = 1024 * 1024;

/// Runs `script` packages from `<root>/<id>/<version>/`, each writing its
/// `<root>/<id>/data/`, each call in a fresh folder under `temp`.
pub struct ScriptHost {
    layout: Layout,
    runner: Runner,
    ids: Arc<dyn Ids>,
}

impl std::fmt::Debug for ScriptHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptHost").field("root", &self.layout.root).finish_non_exhaustive()
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
        Self { layout: Layout { root: root.into(), temp: temp.into(), confinement }, runner, ids }
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
            let tmpdir = self.layout.temp.join(format!("call-{}", self.ids.uuid()));
            let answer = self.call(package, declared, input, env, timeout, &tmpdir).await;
            remove_temp(&package.id, &tmpdir).await;
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
        let confined = self.layout.confine(package, name, &action.run, &env, tmpdir).await?;
        answer_of(&self.runner, confined, &self.layout.package_dir(package), input, timeout, (id, name)).await
    }
}

/// Runs a confined script action in `cwd` with `input` on stdin, and reads
/// its answer from stdout; `(id, name)` name it in the log.
pub(crate) async fn answer_of(
    runner: &Runner,
    confined: eos_core::capability::Confined,
    cwd: &Path,
    input: Value,
    timeout: Duration,
    (id, name): (&str, &str),
) -> Result<Value, ActionError> {
    let mut environment = Env::empty();
    for (variable, value) in &confined.env {
        environment = environment.set(variable, value);
    }
    let body = serde_json::to_vec(&input).map_err(|_| ActionError::Failed { kind: FailureKind::Internal })?;
    let command = Command::new(&confined.program)
        .args(&confined.args)
        .cwd(cwd)
        .env(environment)
        .stdin(body)
        .timeout(timeout)
        .max_output(OUTPUT_MAX_BYTES, Overflow::Fail);
    let ran = runner.run(command).await;
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
