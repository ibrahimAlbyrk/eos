//! A capability's command under the OS sandbox (06 G3): it reads its own
//! package, the system's folders and what its manifest's `reach` names,
//! writes only its `data/` and its call's temp folder, reaches only the
//! declared hosts through a filtering proxy, sends Apple Events only to the
//! declared apps, and never runs `/usr/bin/security` or asks the Keychain's
//! daemons. Everything else is denied and reported.

use std::fmt;
use std::path::PathBuf;

use eos_domain::capability::manifest::Reach;

use crate::BoxFuture;

/// One command of a capability and what it may touch. Every path is
/// absolute.
#[derive(Clone)]
pub struct ConfineSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Where it starts. Readable only when it is one of the paths below.
    pub cwd: PathBuf,
    /// The whole environment it sees: nothing of Eos's is inherited, and a
    /// secret reaches it only as one of its manifest's variables.
    pub env: Vec<(String, String)>,
    /// The installed package folder: readable.
    pub package: PathBuf,
    /// Its `data/` folder: readable and writable.
    pub data: PathBuf,
    /// This call's temp folder, its `TMPDIR`: made if missing, readable and
    /// writable.
    pub tmpdir: PathBuf,
    /// Its manifest's hosts, Apple Event targets and further readable files.
    pub reach: Reach,
    /// The Forge's audit run: reads outside its paths are let through and
    /// reported, and then nothing leaves (no host, no Apple Event, whatever
    /// `reach` names).
    pub audit: bool,
}

impl fmt::Debug for ConfineSpec {
    // The environment carries secrets: names only.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let env: Vec<&str> = self.env.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("ConfineSpec")
            .field("program", &self.program)
            .field("package", &self.package)
            .field("env", &env)
            .field("audit", &self.audit)
            .finish_non_exhaustive()
    }
}

/// The command to start, with Eos's own process runner, exactly as given:
/// `program` with `args` in the spec's `cwd`, with exactly `env`.
pub struct Confined {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The spec's environment with the sandbox's own variables over it.
    pub env: Vec<(String, String)>,
    /// Held while the child runs; finished once it has exited.
    pub guard: Box<dyn ConfineGuard>,
}

impl fmt::Debug for Confined {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Confined").field("program", &self.program).finish_non_exhaustive()
    }
}

/// Collects what a confined command was denied while it runs.
pub trait ConfineGuard: Send {
    /// What it was denied or, in an audit, read outside its paths.
    fn finish(self: Box<Self>) -> BoxFuture<'static, ConfineReport>;
}

/// What a confined command was denied. It was denied nothing only when
/// `violations` is empty, `more` is 0 and `watched` is true.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfineReport {
    /// Each once, in the order they came, at most 50.
    pub violations: Vec<Violation>,
    /// How many more there were.
    pub more: usize,
    /// Whether the OS sandbox's own denials were read; when not,
    /// `violations` holds only the proxy's refusals.
    pub watched: bool,
}

/// One thing a confined command was denied (or, in an audit, read).
/// Denials that name none of these (sysctl, IOKit) are enforced, not listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    FileRead {
        path: PathBuf,
    },
    FileWrite {
        path: PathBuf,
    },
    /// The host and port the proxy refused (`example.com:443`), or the
    /// socket as the kernel names it (`remote:*:443`), which has no host.
    Network {
        target: String,
    },
    Exec {
        path: PathBuf,
    },
    Mach {
        service: String,
    },
    AppleEvent {
        bundle_id: String,
    },
}

/// Why a command was not confined. Nothing runs unconfined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfineError {
    /// The OS sandbox does not work on this Mac.
    Unavailable,
    /// A path the sandbox cannot name, or the temp folder could not be made.
    Failed(String),
}

impl fmt::Display for ConfineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfineError::Unavailable => f.write_str("the sandbox does not work on this Mac"),
            ConfineError::Failed(why) => write!(f, "the command could not be confined: {why}"),
        }
    }
}

impl std::error::Error for ConfineError {}

/// Wraps a capability's command in the OS sandbox.
pub trait Confinement: Send + Sync {
    fn command(&self, spec: ConfineSpec) -> BoxFuture<'_, Result<Confined, ConfineError>>;
}
