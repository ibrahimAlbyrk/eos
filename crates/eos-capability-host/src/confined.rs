//! What both forms share: where a package lives, how its command is put
//! under the sandbox, and what is logged of what the sandbox denied.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_core::capability::{
    ActionError, ConfineError, ConfineReport, ConfineSpec, Confined, Confinement, FailureKind, Package, Violation,
};
use zeroize::Zeroizing;

/// The state code an action is refused with while the sandbox does not work.
pub const SANDBOX_UNAVAILABLE: &str = "sandbox_unavailable";

/// What a confined program finds on its `PATH`: the system's own tools.
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Packages at `<root>/<id>/<version>/`, each writing its `<root>/<id>/data/`,
/// each command with a fresh folder under `temp`.
#[derive(Clone)]
pub(crate) struct Layout {
    pub(crate) root: PathBuf,
    pub(crate) temp: PathBuf,
    pub(crate) confinement: Arc<dyn Confinement>,
}

impl Layout {
    pub(crate) fn package_dir(&self, package: &Package) -> PathBuf {
        self.root.join(&package.id).join(&package.version)
    }

    fn data_dir(&self, package: &Package) -> PathBuf {
        self.root.join(&package.id).join("data")
    }

    /// `line` (a program and its arguments) under the sandbox, started in
    /// the package folder with only `PATH`, `HOME` (its data folder) and the
    /// secrets in their variables. `what` names the command in the log.
    pub(crate) async fn confine(
        &self,
        package: &Package,
        what: &str,
        line: &[String],
        env: &[(String, Zeroizing<String>)],
        tmpdir: &Path,
    ) -> Result<Confined, ActionError> {
        let id = package.id.as_str();
        let Some((program, args)) = line.split_first() else {
            return Err(code_failed(id, what, "no program to run"));
        };
        // Paths reach the sandbox as written: one it cannot name confines nothing.
        if !Path::new(program).is_absolute() {
            return Err(code_failed(id, what, "its program is no absolute path"));
        }
        if package.manifest.reach.files_read.iter().any(|path| !Path::new(path).is_absolute()) {
            return Err(code_failed(id, what, "a file it reads is no absolute path"));
        }
        let (package_dir, data) = (self.package_dir(package), self.data_dir(package));
        if let Err(error) = tokio::fs::create_dir_all(&data).await {
            tracing::warn!(capability = id, what, %error, "a capability's data folder could not be made");
            return Err(ActionError::Failed { kind: FailureKind::Internal });
        }
        let mut variables =
            vec![("PATH".to_owned(), SYSTEM_PATH.to_owned()), ("HOME".to_owned(), data.to_string_lossy().into_owned())];
        // Secrets go in the variables their manifest names, and nowhere else.
        variables.extend(env.iter().map(|(name, value)| (name.clone(), value.as_str().to_owned())));
        let spec = ConfineSpec {
            program: PathBuf::from(program),
            args: args.to_vec(),
            cwd: package_dir.clone(),
            env: variables,
            package: package_dir,
            data,
            tmpdir: tmpdir.to_owned(),
            reach: package.manifest.reach.clone(),
            audit: false,
        };
        self.confinement.command(spec).await.map_err(|error| match error {
            ConfineError::Unavailable => {
                tracing::warn!(capability = id, what, "the sandbox does not work: the command did not run");
                ActionError::NotReady(SANDBOX_UNAVAILABLE.into())
            }
            ConfineError::Failed(_) => code_failed(id, what, "it could not be confined"),
        })
    }
}

/// Removes a command's temp folder once it has ended.
pub(crate) async fn remove_temp(id: &str, tmpdir: &Path) {
    if let Err(error) = tokio::fs::remove_dir_all(tmpdir).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(capability = id, %error, "a command's temp folder stays");
    }
}

pub(crate) fn code_failed(id: &str, what: &str, why: &'static str) -> ActionError {
    tracing::warn!(capability = id, what, why, "a capability's code did not run");
    ActionError::Failed { kind: FailureKind::Code }
}

/// Logs what the sandbox denied, by kind: what was reached is the
/// capability's business, and a path or host can carry the user's data.
pub(crate) fn report(id: &str, what: &str, report: ConfineReport) {
    if report.violations.is_empty() && report.more == 0 {
        if !report.watched {
            tracing::debug!(capability = id, what, "the sandbox's own denials were not read");
        }
        return;
    }
    let count = |pick: fn(&Violation) -> bool| report.violations.iter().filter(|v| pick(v)).count();
    tracing::warn!(
        capability = id,
        what,
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
