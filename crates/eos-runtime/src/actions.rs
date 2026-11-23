//! Direct actions and named queries: what a button on a surface, a Needs-you
//! card or the phone may do, and what a live part may read, without an agent.
//!
//! The feature that does the work declares each one through
//! `Module::direct_actions` and `Module::surface_queries`; `Runtime::build`
//! fails when two modules declare one id, then fills [`Actions`], which every
//! module holds from the kernel and reads once the app is built. Who may
//! press what, with which arguments, is the dispatcher's job; the registry
//! only says what exists.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use eos_contracts::ActionClass;
use eos_surface::Type;
use serde_json::Value;

use crate::router::BoxFuture;

/// Which surfaces may run an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionScope {
    /// Only a surface of the routine the action acts on.
    OwnerRoutine,
    Any,
}

impl ActionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            ActionScope::OwnerRoutine => "owner_routine",
            ActionScope::Any => "any",
        }
    }
}

/// One run of an action, its arguments typed by the core.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionCall {
    pub action_id: String,
    /// The routine of the surface it was pressed on, when there is one.
    pub routine_id: Option<String>,
    pub args: Value,
    /// `dashboard`, `phone`, `mail_link` or `app`.
    pub origin: String,
    /// The record the dispatcher keeps of this run.
    pub record_id: String,
}

/// Why an action or a query did not do its work: a kind for the record and
/// a short reason the button shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionFailure {
    pub kind: String,
    pub reason: String,
}

impl ActionFailure {
    pub fn new(kind: &str, reason: impl Into<String>) -> Self {
        ActionFailure { kind: kind.to_owned(), reason: reason.into() }
    }
}

pub trait ActionHandler: Send + Sync + 'static {
    /// Does the action's work; answers what the button may show.
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>>;
}

/// One read of a named query.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryCall {
    pub query_id: String,
    /// The routine that owns the surface reading it; a query answers only
    /// counts and kinds without one.
    pub routine_id: Option<String>,
    pub args: Value,
}

pub trait QueryHandler: Send + Sync + 'static {
    fn read(&self, call: QueryCall) -> BoxFuture<'_, Result<Value, ActionFailure>>;
}

#[derive(Clone)]
pub struct ActionDecl {
    /// `routine.run_again`.
    pub id: &'static str,
    pub title: &'static str,
    pub args: Type,
    pub class: ActionClass,
    pub scope: ActionScope,
    pub handler: Arc<dyn ActionHandler>,
}

#[derive(Clone)]
pub struct QueryDecl {
    /// `routine.status`.
    pub id: &'static str,
    pub title: &'static str,
    pub args: Type,
    pub scope: ActionScope,
    pub handler: Arc<dyn QueryHandler>,
}

impl std::fmt::Debug for ActionDecl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActionDecl").field("id", &self.id).field("class", &self.class).finish_non_exhaustive()
    }
}

impl std::fmt::Debug for QueryDecl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryDecl").field("id", &self.id).finish_non_exhaustive()
    }
}

/// An argument type that takes nothing.
pub fn no_args() -> Type {
    Type::Object { fields: Vec::new() }
}

/// Every declared action and query, by id.
#[derive(Debug, Default)]
pub struct ActionRegistry {
    actions: BTreeMap<&'static str, ActionDecl>,
    queries: BTreeMap<&'static str, QueryDecl>,
}

impl ActionRegistry {
    pub(crate) fn new(actions: Vec<ActionDecl>, queries: Vec<QueryDecl>) -> Self {
        ActionRegistry {
            actions: actions.into_iter().map(|a| (a.id, a)).collect(),
            queries: queries.into_iter().map(|q| (q.id, q)).collect(),
        }
    }

    pub fn action(&self, id: &str) -> Option<&ActionDecl> {
        self.actions.get(id)
    }

    pub fn query(&self, id: &str) -> Option<&QueryDecl> {
        self.queries.get(id)
    }

    /// Every action, by id.
    pub fn actions(&self) -> impl Iterator<Item = &ActionDecl> {
        self.actions.values()
    }

    pub fn queries(&self) -> impl Iterator<Item = &QueryDecl> {
        self.queries.values()
    }
}

/// The registry once the app is built; empty before.
#[derive(Debug, Clone, Default)]
pub struct Actions(Arc<OnceLock<ActionRegistry>>);

static EMPTY: OnceLock<ActionRegistry> = OnceLock::new();

impl Actions {
    pub fn registry(&self) -> &ActionRegistry {
        self.0.get().unwrap_or_else(|| EMPTY.get_or_init(ActionRegistry::default))
    }

    pub(crate) fn fill(&self, registry: ActionRegistry) {
        // Set once by `Runtime::build`; a kernel is never built twice.
        let _ = self.0.set(registry);
    }

    /// A registry of the declarations given, for a test that dispatches
    /// without building an app.
    pub fn of(actions: Vec<ActionDecl>, queries: Vec<QueryDecl>) -> Self {
        let out = Actions::default();
        out.fill(ActionRegistry::new(actions, queries));
        out
    }
}
