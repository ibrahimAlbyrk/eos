//! What Eos itself does with a package the Forge built, before the user is
//! asked to install it (06 G2, G9): its offline tests under the sandbox in
//! audit mode, with a fake value planted in each secret's variable, and, only
//! when the user starts it, one live call of its `tests.live` action with the
//! reach its manifest declares.
//!
//! A clean audit is not "no violations": ordinary programs read a few system
//! preference files under any sandbox, and those reads alone are let pass
//! ([`TOLERATED_READS`]). Every other read outside the package, every write,
//! process, Mach service or Apple Event the sandbox stopped, and any network
//! attempt but one through the proxy to a declared host fails the tests. So
//! does an audit whose sandbox denials could not be read, or that was cut
//! short. What the audit cannot see (a confined helper whose process name
//! the sandbox's log filters out) the review has to find in the code.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_contracts::ActionClass;
use eos_core::Ids;
use eos_core::capability::{ActionError, ConfineReport, Confinement, Violation};
use eos_domain::capability::manifest::{Form, Manifest};
use eos_domain::capability::reach::allows;
use eos_domain::capability::scrub::scrub;
use eos_kit_proc::{Command, Env, Overflow, Runner};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::confined::{At, confine_at, remove_temp};
use crate::script::{OUTPUT_MAX_BYTES, answer_of};

/// The longest a package's offline tests run.
pub const TESTS_TIMEOUT: Duration = Duration::from_secs(300);
/// The longest the live call runs.
pub const LIVE_TIMEOUT: Duration = Duration::from_secs(60);
/// The largest file written during the tests that is searched for a planted
/// secret; a larger one fails the tests.
const SCANNED_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The reads outside its paths an audit lets pass: the system's and the
/// user's global preference files, which macOS's own libraries read in any
/// program. Matched as a path's start (`/…`) or as a file name.
pub const TOLERATED_READS: [&str; 3] = ["/Library/Preferences/", "/private/var/db/timezone/", ".GlobalPreferences"];

/// What a package's offline tests came to. `failures` say why in plain
/// words, never with what the code printed, read or reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrialOutcome {
    pub passed: bool,
    pub failures: Vec<String>,
    /// Reads of [`TOLERATED_READS`] the audit let pass.
    pub tolerated: usize,
}

/// Runs the Forge's tests of a package in its build folder.
pub struct Trial {
    confinement: Arc<dyn Confinement>,
    runner: Runner,
    ids: Arc<dyn Ids>,
}

impl std::fmt::Debug for Trial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Trial").finish_non_exhaustive()
    }
}

impl Trial {
    pub fn new(confinement: Arc<dyn Confinement>, runner: Runner, ids: Arc<dyn Ids>) -> Self {
        Self { confinement, runner, ids }
    }

    /// Runs `manifest.tests.command` in `package` under the audit, with a
    /// fresh data and temp folder under `work` (removed after) and a fake
    /// value in each secret's variable. It passes when the command ended
    /// well, the audit is clean and no planted value shows in its output or
    /// in a file it wrote.
    pub async fn offline(&self, package: &Path, manifest: &Manifest, work: &Path) -> TrialOutcome {
        let Some(tests) = &manifest.tests else {
            return failed("the package declares no tests");
        };
        let work = work.join(format!("trial-{}", self.ids.uuid()));
        let outcome = self.audited(package, manifest, &tests.command, &work).await;
        remove_temp(&manifest.id, &work).await;
        outcome
    }

    async fn audited(&self, package: &Path, manifest: &Manifest, line: &[String], work: &Path) -> TrialOutcome {
        let id = manifest.id.as_str();
        let plants: Vec<(String, Zeroizing<String>)> = manifest
            .secrets
            .iter()
            .filter_map(|secret| secret.env.clone())
            .map(|variable| (variable, Zeroizing::new(format!("eos-planted-{}", self.ids.uuid()))))
            .collect();
        let at = At { id, package: package.to_owned(), data: work.join("data"), manifest, audit: true };
        let tmpdir = work.join("tmp");
        let confined = match confine_at(self.confinement.as_ref(), &at, "tests", line, &plants, &tmpdir).await {
            Ok(confined) => confined,
            Err(ActionError::NotReady(_)) => return failed("the sandbox does not work on this Mac, so nothing ran"),
            Err(_) => return failed("its tests could not be put under the sandbox"),
        };
        let mut environment = Env::empty();
        for (variable, value) in &confined.env {
            environment = environment.set(variable, value);
        }
        let command = Command::new(&confined.program)
            .args(&confined.args)
            .cwd(package)
            .env(environment)
            .timeout(TESTS_TIMEOUT)
            .max_output(OUTPUT_MAX_BYTES, Overflow::Fail);
        let ran = self.runner.run(command).await;
        let report = confined.guard.finish().await;
        let (mut failures, tolerated) = judge(&report, manifest);
        match ran {
            Ok(output) if output.timed_out => failures.push("its tests ran past five minutes".into()),
            Ok(output) => {
                if !output.success() {
                    failures.push("its tests failed".into());
                }
                let said = [output.stdout, output.stderr].concat();
                if leaks(&said, &plants) {
                    failures.push("a planted secret showed in what its tests printed".into());
                }
            }
            Err(eos_kit_proc::Error::OutputTooLarge { .. }) => {
                failures.push("its tests printed more than 1 MiB".into())
            }
            Err(_) => failures.push("its tests could not start".into()),
        }
        match written(work.to_owned()).await {
            Ok(files) if files.iter().any(|bytes| leaks(bytes, &plants)) => {
                failures.push("a planted secret showed in a file its tests wrote".into());
            }
            Ok(_) => {}
            Err(why) => failures.push(why.into()),
        }
        tracing::info!(capability = id, failures = failures.len(), tolerated, "a package's offline tests ran");
        TrialOutcome { passed: failures.is_empty(), failures, tolerated }
    }

    /// The live call of `manifest.tests.live` from `package`, with the reach
    /// its manifest declares: `env` holds the settings and secrets the user
    /// gave. Only a `script` package's action that at most tells the user.
    pub async fn live(
        &self,
        package: &Path,
        manifest: &Manifest,
        input: Value,
        env: Vec<(String, Zeroizing<String>)>,
        work: &Path,
    ) -> Result<Value, ActionError> {
        let id = manifest.id.as_str();
        let name = manifest.tests.as_ref().and_then(|tests| tests.live.as_deref()).ok_or(ActionError::NotFound)?;
        let action = manifest.action(name).ok_or(ActionError::NotFound)?;
        if !matches!(action.class, ActionClass::Read | ActionClass::WriteLocal | ActionClass::TellUser) {
            return Err(ActionError::Invalid(format!("the live test {name} may at most tell you")));
        }
        if manifest.form != Form::Script {
            return Err(ActionError::Invalid("only a script package's live test is run".into()));
        }
        let work = work.join(format!("live-{}", self.ids.uuid()));
        let at = At { id, package: package.to_owned(), data: work.join("data"), manifest, audit: false };
        let tmpdir = work.join("tmp");
        let answer = match confine_at(self.confinement.as_ref(), &at, name, &action.run, &env, &tmpdir).await {
            Ok(confined) => answer_of(&self.runner, confined, package, input, LIVE_TIMEOUT, (id, name)).await,
            Err(refused) => Err(refused),
        };
        remove_temp(id, &work).await;
        answer
    }
}

fn failed(why: &str) -> TrialOutcome {
    TrialOutcome { passed: false, failures: vec![why.to_owned()], tolerated: 0 }
}

/// Whether any form of a planted value is in `bytes`.
fn leaks(bytes: &[u8], plants: &[(String, Zeroizing<String>)]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let values: Vec<&str> = plants.iter().map(|(_, value)| value.as_str()).collect();
    !values.is_empty() && scrub(&text, &values) != text
}

/// Why the audit fails the tests, and how many reads it let pass.
pub fn judge(report: &ConfineReport, manifest: &Manifest) -> (Vec<String>, usize) {
    let mut failures = Vec::new();
    if !report.watched {
        failures.push("the sandbox's own denials could not be read, so the audit proves nothing".to_owned());
    }
    if report.more > 0 {
        failures.push("the sandbox stopped more than it lists".to_owned());
    }
    let mut tolerated = 0;
    let mut found = |why: &str| {
        if !failures.iter().any(|known| known == why) {
            failures.push(why.to_owned());
        }
    };
    for violation in &report.violations {
        match violation {
            Violation::FileRead { path } if tolerated_read(path) => tolerated += 1,
            Violation::FileRead { .. } => found("it read files outside its package"),
            Violation::FileWrite { .. } => found("it wrote outside its data and temp folders"),
            Violation::Exec { .. } => found("it started a program it may not"),
            Violation::Mach { .. } => found("it asked a system service it may not"),
            Violation::AppleEvent { .. } => found("its offline tests asked another app"),
            Violation::Network { target } => match host_of(target) {
                Some(host) if allows(&manifest.reach.hosts, host) => {}
                Some(_) => found("it reached a host its manifest does not declare"),
                // The kernel names no host: it went around the proxy.
                None => found("it reached the network around Eos's proxy"),
            },
        }
    }
    (failures, tolerated)
}

fn tolerated_read(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let name = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
    TOLERATED_READS.iter().any(|read| match read.strip_prefix('/') {
        Some(_) => text.starts_with(read) && !text.contains("/../"),
        None => name.starts_with(read),
    })
}

/// The host of a proxy's refusal (`example.com:443`); none for the kernel's
/// (`remote:*:443`).
fn host_of(target: &str) -> Option<&str> {
    let (host, port) = target.rsplit_once(':')?;
    let named = !host.is_empty() && !host.contains([':', '*']) && port.chars().all(|c| c.is_ascii_digit());
    named.then_some(host)
}

/// Every file under `dir`, read; a link refuses them, as a package's would.
async fn written(dir: PathBuf) -> Result<Vec<Vec<u8>>, &'static str> {
    fn visit(dir: &Path, out: &mut Vec<Vec<u8>>) -> Result<(), &'static str> {
        let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
        for entry in entries.flatten() {
            let kind = entry.file_type().map_err(|_| "a file its tests wrote could not be read")?;
            let path = entry.path();
            if kind.is_dir() {
                visit(&path, out)?;
            } else if kind.is_file() {
                let size = entry.metadata().map_err(|_| "a file its tests wrote could not be read")?.len();
                if size > SCANNED_MAX_BYTES {
                    return Err("its tests wrote a file too large to search for secrets");
                }
                out.push(std::fs::read(&path).map_err(|_| "a file its tests wrote could not be read")?);
            } else {
                return Err("its tests left a link or a special file");
            }
        }
        Ok(())
    }
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        visit(&dir, &mut out).map(|()| out)
    })
    .await
    .map_err(|_| "the files its tests wrote could not be searched")?
}
