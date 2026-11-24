//! [`Confinement`] over the engine's sandbox: a capability's reach (06 G3)
//! as the engine's confinement spec, and its report as plain data. It runs
//! on the process's one proxy and violation monitor.

use std::path::PathBuf;

use eos_agent_sdk as sdk;
use eos_core::BoxFuture;
use eos_core::capability::{ConfineError, ConfineGuard, ConfineReport, ConfineSpec, Confined, Confinement, Violation};

use crate::{Engine, LazyEngine};

/// Builds the engine on the first confined command; an engine that cannot
/// be built confines nothing, so nothing runs.
impl Confinement for LazyEngine {
    fn command(&self, spec: ConfineSpec) -> BoxFuture<'_, Result<Confined, ConfineError>> {
        Box::pin(async move {
            match self.engine().await {
                Ok(engine) => engine.command(spec).await,
                Err(error) => {
                    tracing::warn!(%error, "the engine could not be built to confine a command");
                    Err(ConfineError::Unavailable)
                }
            }
        })
    }
}

impl Confinement for Engine {
    fn command(&self, spec: ConfineSpec) -> BoxFuture<'_, Result<Confined, ConfineError>> {
        Box::pin(async move {
            // Fail closed: without the OS sandbox nothing runs.
            if !self.sdk().sandbox_available() {
                return Err(ConfineError::Unavailable);
            }
            let confined = self.sdk().confine(engine_spec(spec)).await.map_err(|e| match e {
                sdk::ConfineError::Unavailable => ConfineError::Unavailable,
                other => ConfineError::Failed(other.to_string()),
            })?;
            let sdk::Confined { program, args, env, guard } = confined;
            Ok(Confined { program, args, env, guard: Box::new(Guard(guard)) })
        })
    }
}

/// Reads the package and `files_read`, writes `data/` (and the temp folder,
/// which the engine always opens).
fn engine_spec(spec: ConfineSpec) -> sdk::ConfineSpec {
    let ConfineSpec { program, args, cwd, env, package, data, tmpdir, reach, audit } = spec;
    let mut read_paths = vec![package];
    read_paths.extend(reach.files_read.iter().map(PathBuf::from));
    sdk::ConfineSpec {
        program,
        args,
        cwd,
        env,
        read_paths,
        write_paths: vec![data],
        hosts: reach.hosts,
        apple_events: reach.apple_events,
        tmpdir,
        audit,
    }
}

struct Guard(sdk::ConfineGuard);

impl ConfineGuard for Guard {
    fn finish(self: Box<Self>) -> BoxFuture<'static, ConfineReport> {
        Box::pin(async move {
            let sdk::ConfineReport { violations, more, watched } = self.0.finish().await;
            ConfineReport { violations: violations.into_iter().map(violation).collect(), more, watched }
        })
    }
}

fn violation(violation: sdk::Violation) -> Violation {
    match violation {
        sdk::Violation::FileRead { path } => Violation::FileRead { path },
        sdk::Violation::FileWrite { path } => Violation::FileWrite { path },
        sdk::Violation::Network { target } => Violation::Network { target },
        sdk::Violation::Exec { path } => Violation::Exec { path },
        sdk::Violation::MachLookup { service } => Violation::Mach { service },
        sdk::Violation::AppleEvent { target } => Violation::AppleEvent { bundle_id: target },
    }
}
