//! Every tool, in registration order, and which of them a session gets.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::SessionFactsRole;
use eos_core::agent::{
    HostTool, LaunchSpec, ModelCatalog, Peers, ToolSets, UserNotifier, UserQuestions, WorkerControl,
};
use eos_core::browser::BrowserTools;
use eos_core::os::TimeZone;
use eos_core::pages::PageEditor;
use eos_core::plugin::Plugins;
use eos_core::profile::{MemorySearch, MemorySuggestions};
use eos_core::store::Store;
use eos_core::transfer::AgentTransfers;
use eos_core::{Clock, Sleeper};
use eos_prompts::PromptRegistry;
use eos_prompts::tool_descriptions::render_tool_descriptions;
use eos_workers::WorkerDefinitions;

use crate::control::Control;
use crate::tool::{Bound, Spec};
use crate::visual::Visual;
use crate::{browser, control, memory, pages, peers, plugins, time, transfer, user, visual};

/// What the tools call. The optional parts belong to features that may not
/// be in the app yet: without one, its tools are in no session.
pub struct Services {
    /// The prompt library the descriptions are rendered from.
    pub prompts: Arc<PromptRegistry>,
    pub clock: Arc<dyn Clock>,
    pub sleeper: Arc<dyn Sleeper>,
    pub zone: Arc<dyn TimeZone>,
    pub store: Arc<dyn Store>,
    pub models: Arc<dyn ModelCatalog>,
    pub definitions: Arc<WorkerDefinitions>,
    pub workers: Arc<dyn WorkerControl>,
    pub notifier: Arc<dyn UserNotifier>,
    pub questions: Arc<dyn UserQuestions>,
    pub pages: Arc<dyn PageEditor>,
    pub memory_search: Arc<dyn MemorySearch>,
    pub memory_suggestions: Arc<dyn MemorySuggestions>,
    pub plugins: Arc<dyn Plugins>,
    pub browser: Option<Arc<dyn BrowserTools>>,
    pub visual: Option<Visual>,
    pub peers: Option<Arc<dyn Peers>>,
    pub transfers: Option<Arc<dyn AgentTransfers>>,
}

impl std::fmt::Debug for Services {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Services").finish_non_exhaustive()
    }
}

/// The server a session's tools are named under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Server {
    Orchestrator,
    Worker,
}

impl Server {
    fn name(self) -> &'static str {
        match self {
            Server::Orchestrator => "orchestrator",
            Server::Worker => "worker",
        }
    }
}

/// A tool as one server hands it out, with the description it was built from.
struct Handed {
    description: String,
    tool: Arc<dyn HostTool>,
}

/// The registry of every tool. One value serves every session; sessions
/// with the same tools get the same `Arc`s.
pub struct Tools {
    prompts: Arc<PromptRegistry>,
    plugins: Arc<dyn Plugins>,
    pub(crate) orchestrator: Vec<Spec>,
    pub(crate) worker: Vec<Spec>,
    pub(crate) peer: Vec<Spec>,
    pub(crate) focused: Vec<Spec>,
    /// The tools handed out so far. A description is rendered anew for each
    /// session (an edited prompt reaches the next one); the tool is rebuilt
    /// only when its description changed. Bounded by the registry's size.
    handed: Mutex<HashMap<(Server, &'static str), Handed>>,
}

impl std::fmt::Debug for Tools {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tools").finish_non_exhaustive()
    }
}

impl Tools {
    pub fn new(s: Services) -> Self {
        let c = Control {
            store: s.store.clone(),
            models: s.models.clone(),
            workers: s.workers.clone(),
            definitions: s.definitions.clone(),
        };
        // The parts both surfaces share, in the order both list them.
        let shared = || {
            let mut list = pages::specs(&s.pages);
            list.extend(memory::specs(&s.memory_search, &s.memory_suggestions));
            if let Some(browser) = &s.browser {
                list.extend(browser::specs(browser));
            }
            list
        };
        let visual = || s.visual.as_ref().map(|v| visual::specs(v, &s.clock)).unwrap_or_default();

        // Registration order is what the model reads: keep it as it was.
        let mut orchestrator = vec![
            control::spawn_worker(&c),
            control::list_active_workers(&c),
            control::get_worker(&c),
            control::kill_worker(&c),
            control::message_worker(&c),
            control::list_pending_permissions(&c),
            user::notify_user(&s.notifier),
            user::ask_user(&s.questions),
            control::list_available_workers(&c),
            control::create_worker(&c),
            control::integrate_workers(&c),
            time::spec(&s.clock, &s.zone),
            control::get_worker_messages(&c),
        ];
        orchestrator.extend(shared());
        orchestrator.extend(visual());
        orchestrator.extend(plugins::specs(&s.plugins));

        let mut worker = vec![control::send_message_to_parent(&c), time::spec(&s.clock, &s.zone)];
        worker.extend(shared());
        worker.extend(plugins::specs(&s.plugins));

        let peer = s.peers.as_ref().map(peers::specs).unwrap_or_default();

        let mut focused = Vec::new();
        if let Some(transfers) = &s.transfers {
            focused.push(transfer::spec(transfers, &s.clock, &s.sleeper));
        }
        focused.extend(visual());

        Self { prompts: s.prompts, plugins: s.plugins, orchestrator, worker, peer, focused, handed: Mutex::default() }
    }

    /// The registry entries a session of this kind gets, in order.
    fn listed(&self, spec: &LaunchSpec) -> (Server, Vec<&Spec>) {
        let off = self.plugins.disabled_builtins();
        let on = |tool: &&Spec| tool.plugin.is_none_or(|plugin| !off.iter().any(|id| id == plugin));
        if spec.role == SessionFactsRole::Orchestrator {
            return (Server::Orchestrator, self.orchestrator.iter().filter(on).collect());
        }
        let mut list: Vec<&Spec> = self.worker.iter().collect();
        if spec.collaborate {
            list.extend(&self.peer);
        }
        if spec.role == SessionFactsRole::Focused {
            list.extend(&self.focused);
        }
        list.retain(on);
        (Server::Worker, list)
    }
}

impl ToolSets for Tools {
    fn for_session(&self, spec: &LaunchSpec) -> Vec<Arc<dyn HostTool>> {
        let (server, list) = self.listed(spec);
        let names: Vec<&str> = list.iter().map(|tool| tool.name).collect();
        // An edited prompt file reaches the next session.
        self.prompts.reload();
        let descriptions = render_tool_descriptions(self.prompts.clone(), &names);
        let mut handed = self.handed.lock().unwrap_or_else(PoisonError::into_inner);
        list.into_iter()
            .zip(descriptions)
            .map(|(tool, (_, description))| {
                let entry = handed.entry((server, tool.name));
                let kept = entry
                    .and_modify(|had| {
                        if had.description != description {
                            *had = hand(server, tool, description.clone());
                        }
                    })
                    .or_insert_with(|| hand(server, tool, description.clone()));
                kept.tool.clone()
            })
            .collect()
    }
}

fn hand(server: Server, tool: &Spec, description: String) -> Handed {
    Handed { tool: Arc::new(Bound::new(server.name(), tool, description.clone())), description }
}
