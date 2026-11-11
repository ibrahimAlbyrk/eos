//! A feature module: one feature's routes, events, jobs and reactions, built
//! in one place from the kernel services it needs (passed in, never reached
//! for). `eos-app` builds every module; the runtime composes them, registers
//! their routes, starts them and stops them on shutdown. Modules never depend
//! on each other — what one needs from another comes in through its
//! constructor as a trait.

use std::any::Any;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use eos_contracts::AgentEvent;
use eos_core::agent::ToolInputDelta;

use crate::bus::{Event, TopicDecl};
use crate::error::{Conflict, Error, panic_message};
use crate::idle::IdleHook;
use crate::router::{BoxFuture, PluginSwitch, RouteDef, Router};

/// A value the runtime carries for another crate without knowing its type
/// (a slash command, a sync domain). The owner downcasts it.
pub type Opaque = Arc<dyn Any + Send + Sync>;

/// Why a module could not start. The runtime only reports it.
pub type ModuleError = Box<dyn std::error::Error + Send + Sync>;

/// A prompt variable's value, read at each spawn (`GENUI_LEVEL`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptValue {
    Text(String),
    Flag(bool),
}

/// Settings keys only this feature's own (user-token) route may write; the
/// flat settings route refuses them and names `via` instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedSettings {
    pub keys: Vec<&'static str>,
    pub via: &'static str,
}

/// An Eos-owned slash command a feature adds to the composer. The command
/// object is the session service's type; the runtime carries it unopened.
#[derive(Clone)]
pub struct SlashCommandDecl {
    pub name: &'static str,
    pub command: Opaque,
}

/// Data a feature lets follow the user to their other computers: its sync
/// domain (the sync feature's type, carried unopened), and the bus topic its
/// local edits announce so sync pushes them. `is_local` tells an edit apart
/// from one sync itself applied.
#[derive(Clone)]
pub struct SyncContribution {
    pub domain: &'static str,
    pub handle: Opaque,
    pub change_topic: Option<&'static str>,
    pub is_local: Option<IsLocal>,
}

/// Whether a change event was made here rather than applied by sync.
pub type IsLocal = Arc<dyn Fn(&Event) -> bool + Send + Sync>;

impl ProtectedSettings {
    /// Why the flat settings route must refuse a patch that names `keys`, or
    /// `None` when none of them is this feature's: `a, b are set only through
    /// PUT /api/settings/x`. That route takes no user token, so without this
    /// an agent could undo a choice only the user may make.
    pub fn refusal<'k>(&self, keys: impl IntoIterator<Item = &'k str>) -> Option<String> {
        let wanted: Vec<&str> = keys.into_iter().collect();
        let gated: Vec<&str> = self.keys.iter().copied().filter(|k| wanted.contains(k)).collect();
        let verb = match gated.len() {
            0 => return None,
            1 => "is",
            _ => "are",
        };
        Some(format!("{} {verb} set only through {}", gated.join(", "), self.via))
    }
}

impl std::fmt::Debug for SlashCommandDecl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlashCommandDecl").field("name", &self.name).finish_non_exhaustive()
    }
}

impl std::fmt::Debug for SyncContribution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncContribution")
            .field("domain", &self.domain)
            .field("change_topic", &self.change_topic)
            .finish_non_exhaustive()
    }
}

fn done<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

/// What a feature contributes. Every method has a default: a module
/// implements only what it has.
pub trait Module: Send + Sync + 'static {
    fn id(&self) -> &'static str;

    /// The built-in plugin that switches this feature on and off. While off,
    /// its routes answer 404 `plugin_off` and it hears no agent events.
    fn plugin(&self) -> Option<&'static str> {
        None
    }

    /// Its routes, each with its access rule.
    fn routes(&self) -> Vec<RouteDef> {
        Vec::new()
    }

    /// The bus topics it publishes (`Topic::decl`).
    fn topics(&self) -> Vec<TopicDecl> {
        Vec::new()
    }

    /// The kinds of background job it registers (`transfer`, `dream`, …).
    fn job_kinds(&self) -> Vec<&'static str> {
        Vec::new()
    }

    /// What runs when a worker settles at IDLE with an empty queue, ordered
    /// among everyone's.
    fn idle_hooks(&self) -> Vec<IdleHook> {
        Vec::new()
    }

    fn slash_commands(&self) -> Vec<SlashCommandDecl> {
        Vec::new()
    }

    fn prompt_variables(&self) -> Vec<(&'static str, PromptValue)> {
        Vec::new()
    }

    fn protected_settings(&self) -> Option<ProtectedSettings> {
        None
    }

    fn sync(&self) -> Vec<SyncContribution> {
        Vec::new()
    }

    /// True while this feature holds the worker: every message to it queues.
    fn holds_worker(&self, _worker_id: &str) -> bool {
        false
    }

    /// A tool this feature follows while the model writes its input.
    fn follows_tool_input(&self, _tool: &str) -> bool {
        false
    }

    /// Each piece of a followed tool's input as it arrives.
    fn on_tool_input_delta(&self, _worker_id: &str, _delta: &ToolInputDelta) {}

    /// Every event an agent's session emits, before it is processed and logged.
    fn on_agent_event(&self, _worker_id: &str, _event: &AgentEvent) {}

    /// A session (a root worker and its subtree) was killed, archived or purged.
    fn on_session_ended(&self, _session_key: &str) {}

    /// The app is built (routes registered): start timers and watchers.
    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        done(Ok(()))
    }

    /// The app is ready and is the only one running on this data folder:
    /// start what must never run twice (sync).
    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        done(Ok(()))
    }

    /// The app is shutting down. Has until the shutdown deadline.
    fn stop(&self) -> BoxFuture<'_, ()> {
        done(())
    }
}

/// The modules in composition order, with the calls that fan out to them.
#[derive(Clone)]
pub struct Modules {
    list: Arc<[Arc<dyn Module>]>,
    plugins: Arc<dyn PluginSwitch>,
}

impl std::fmt::Debug for Modules {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.list.iter().map(|m| m.id())).finish()
    }
}

/// Everything the modules declared, checked for clashes.
pub struct Composed {
    pub modules: Modules,
    /// Each route carries its module's id and plugin.
    pub routes: Vec<RouteDef>,
    pub topics: Vec<TopicDecl>,
    pub job_kinds: Vec<&'static str>,
    pub idle_hooks: Vec<IdleHook>,
    pub slash_commands: Vec<SlashCommandDecl>,
    pub protected_settings: Vec<ProtectedSettings>,
    pub sync: Vec<SyncContribution>,
}

impl std::fmt::Debug for Composed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Composed")
            .field("modules", &self.modules)
            .field("routes", &self.routes.len())
            .finish_non_exhaustive()
    }
}

/// Finds two modules declaring one name.
struct Claims {
    what: &'static str,
    seen: HashMap<String, &'static str>,
}

impl Claims {
    fn new(what: &'static str) -> Self {
        Self { what, seen: HashMap::new() }
    }

    fn claim(&mut self, name: &str, owner: &'static str, conflicts: &mut Vec<Conflict>) {
        if let Some(first) = self.seen.get(name) {
            conflicts.push(Conflict {
                what: self.what,
                name: name.to_owned(),
                first: (*first).to_owned(),
                second: owner.to_owned(),
            });
        } else {
            self.seen.insert(name.to_owned(), owner);
        }
    }
}

/// `^[a-z][a-z0-9-]{0,39}$`: what a job kind may look like on the wire.
fn valid_job_kind(kind: &str) -> bool {
    let mut bytes = kind.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && kind.len() <= 40
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Collects what every module contributes. Fails — listing every clash — when
/// two modules share an id, a route (same method and shape), a topic, a job
/// kind, an idle hook id, a slash command, a protected settings key or a sync
/// domain. Order of `modules` is start order; nothing else depends on it.
pub fn compose(modules: Vec<Arc<dyn Module>>, plugins: Arc<dyn PluginSwitch>) -> Result<Composed, Error> {
    let mut conflicts = Vec::new();
    let mut ids = Claims::new("module");
    let mut topic_names = Claims::new("topic");
    let mut kinds = Claims::new("job kind");
    let mut hooks = Claims::new("idle hook");
    let mut commands = Claims::new("slash command");
    let mut keys = Claims::new("settings key");
    let mut domains = Claims::new("sync domain");

    let mut out = Composed {
        modules: Modules { list: modules.into(), plugins },
        routes: Vec::new(),
        topics: Vec::new(),
        job_kinds: Vec::new(),
        idle_hooks: Vec::new(),
        slash_commands: Vec::new(),
        protected_settings: Vec::new(),
        sync: Vec::new(),
    };
    for module in out.modules.list.iter() {
        let id = module.id();
        ids.claim(id, id, &mut conflicts);
        let owner: Arc<str> = Arc::from(id);
        let plugin: Option<Arc<str>> = module.plugin().map(Arc::from);
        for route in module.routes() {
            let route = route.owned_by(&owner);
            out.routes.push(match &plugin {
                Some(plugin) => route.plugin(plugin.clone()),
                None => route,
            });
        }
        for topic in module.topics() {
            topic_names.claim(topic.name, id, &mut conflicts);
            out.topics.push(topic);
        }
        for kind in module.job_kinds() {
            if !valid_job_kind(kind) {
                return Err(Error::BadDeclaration { module: id.to_owned(), what: "job kind", name: kind.to_owned() });
            }
            kinds.claim(kind, id, &mut conflicts);
            out.job_kinds.push(kind);
        }
        for hook in module.idle_hooks() {
            hooks.claim(hook.id, id, &mut conflicts);
            out.idle_hooks.push(hook);
        }
        for command in module.slash_commands() {
            commands.claim(command.name, id, &mut conflicts);
            out.slash_commands.push(command);
        }
        if let Some(protected) = module.protected_settings() {
            for key in &protected.keys {
                keys.claim(key, id, &mut conflicts);
            }
            out.protected_settings.push(protected);
        }
        for contribution in module.sync() {
            domains.claim(contribution.domain, id, &mut conflicts);
            out.sync.push(contribution);
        }
    }
    // The router is what knows two patterns have one shape; build one to ask.
    match Router::builder().tolerate_undeclared().routes(out.routes.iter().cloned()).build() {
        Ok(_) => {}
        Err(Error::Conflicts(routes)) => conflicts.extend(routes),
        Err(other) => return Err(other),
    }
    if conflicts.is_empty() { Ok(out) } else { Err(Error::Conflicts(conflicts)) }
}

impl Modules {
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Arc<dyn Module>> + ExactSizeIterator {
        self.list.iter()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    fn guarded(module: &dyn Module, hook: &'static str, call: impl FnOnce()) {
        if let Err(payload) = catch_unwind(AssertUnwindSafe(call)) {
            tracing::error!(module = module.id(), hook, panic = %panic_message(payload.as_ref()), "a module hook panicked");
        }
    }

    /// Hands an agent event to every module whose plugin is on. A module that
    /// panics is logged; the rest still hear the event.
    pub fn on_agent_event(&self, worker_id: &str, event: &AgentEvent) {
        for module in self.list.iter() {
            if module.plugin().is_none_or(|plugin| self.plugins.is_on(plugin)) {
                Self::guarded(module.as_ref(), "on_agent_event", || module.on_agent_event(worker_id, event));
            }
        }
    }

    /// Whether any module follows `tool` while the model writes its input.
    pub fn follows_tool_input(&self, tool: &str) -> bool {
        self.list.iter().any(|m| m.follows_tool_input(tool))
    }

    /// Hands a piece of `tool`'s input to the modules that follow it.
    pub fn on_tool_input_delta(&self, worker_id: &str, tool: &str, delta: &ToolInputDelta) {
        for module in self.list.iter().filter(|m| m.follows_tool_input(tool)) {
            Self::guarded(module.as_ref(), "on_tool_input_delta", || module.on_tool_input_delta(worker_id, delta));
        }
    }

    pub fn on_session_ended(&self, session_key: &str) {
        for module in self.list.iter() {
            Self::guarded(module.as_ref(), "on_session_ended", || module.on_session_ended(session_key));
        }
    }

    /// Whether any module holds the worker (its messages queue meanwhile).
    pub fn holds_worker(&self, worker_id: &str) -> bool {
        self.list.iter().any(|m| m.holds_worker(worker_id))
    }

    /// Every module's prompt variables, read now. A later module's value wins
    /// over an earlier one's of the same name, as today.
    pub fn prompt_variables(&self) -> Vec<(&'static str, PromptValue)> {
        let mut merged: Vec<(&'static str, PromptValue)> = Vec::new();
        for (name, value) in self.list.iter().flat_map(|m| m.prompt_variables()) {
            match merged.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = value,
                None => merged.push((name, value)),
            }
        }
        merged
    }
}

#[cfg(test)]
mod tests;
