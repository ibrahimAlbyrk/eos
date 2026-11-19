//! Signals: what starts a routine's runs.
//!
//! A signal is one thing a source saw (a pull request opened, a run started
//! by hand). Which computer acts on a routine's signals is the [`Runner`]'s
//! to say; [`SoloRunner`] holds every routine here.
//!
//! Changes are announced on `signals:change`. Keys, subjects, scopes and
//! facts are the user's data: logs carry ids, kinds, decisions and counts.

mod runner;

use std::sync::Arc;

use eos_contracts::SignalChange;
use eos_core::os::ZoneRules;
use eos_core::routine::{RoutineDirectory, RunIntake};
use eos_core::signals::{Runner, SignalSources};
use eos_core::store::Store;
use eos_core::{Clock, Ids};
use eos_runtime::bus::{Bus, Topic, TopicDecl};
use eos_runtime::module::Module;

pub use runner::SoloRunner;

pub const SIGNALS_CHANGE: Topic<SignalChange> = Topic::new("signals:change");

/// What the module is built from.
pub struct SignalsParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// The rules of the time zones schedules name.
    pub zones: Arc<dyn ZoneRules>,
    /// The sources the capabilities declare.
    pub sources: Arc<dyn SignalSources>,
    pub runner: Arc<dyn Runner>,
    /// Admits the runs signals start, inside the routing write.
    pub intake: Arc<dyn RunIntake>,
    /// What starts each routine's runs.
    pub directory: Arc<dyn RoutineDirectory>,
    pub bus: Bus,
    /// Whether a matched signal starts its run by itself: true only in the
    /// installed app.
    pub autostart: bool,
}

impl std::fmt::Debug for SignalsParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignalsParts").field("autostart", &self.autostart).finish_non_exhaustive()
    }
}

pub struct SignalsModule {
    parts: SignalsParts,
}

impl std::fmt::Debug for SignalsModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignalsModule").field("autostart", &self.parts.autostart).finish_non_exhaustive()
    }
}

impl SignalsModule {
    pub fn new(parts: SignalsParts) -> Self {
        Self { parts }
    }
}

impl Module for SignalsModule {
    fn id(&self) -> &'static str {
        "signals"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![SIGNALS_CHANGE.decl()]
    }
}
