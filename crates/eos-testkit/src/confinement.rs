//! Confinement as the test scripts it: the command runs as given, and its
//! report holds the violations the test chose.

use std::sync::{Mutex, MutexGuard};

use eos_core::BoxFuture;
use eos_core::capability::{ConfineError, ConfineGuard, ConfineReport, ConfineSpec, Confined, Confinement, Violation};

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Records every spec and reports the scripted violations.
#[derive(Debug, Default)]
pub struct FakeConfinement {
    specs: Mutex<Vec<ConfineSpec>>,
    violations: Mutex<Vec<Violation>>,
}

impl FakeConfinement {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every command reports these.
    pub fn violating(self, violations: Vec<Violation>) -> Self {
        *locked(&self.violations) = violations;
        self
    }

    /// The specs asked for, in order.
    pub fn specs(&self) -> Vec<ConfineSpec> {
        locked(&self.specs).clone()
    }
}

impl Confinement for FakeConfinement {
    fn command(&self, spec: ConfineSpec) -> BoxFuture<'_, Result<Confined, ConfineError>> {
        locked(&self.specs).push(spec.clone());
        let report = ConfineReport { violations: locked(&self.violations).clone(), more: 0, watched: true };
        let confined =
            Confined { program: spec.program, args: spec.args, env: spec.env, guard: Box::new(Scripted(report)) };
        Box::pin(std::future::ready(Ok(confined)))
    }
}

struct Scripted(ConfineReport);

impl ConfineGuard for Scripted {
    fn finish(self: Box<Self>) -> BoxFuture<'static, ConfineReport> {
        Box::pin(std::future::ready(self.0))
    }
}
