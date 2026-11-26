//! Every tool, in registration order, and which of them a session gets.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::SessionFactsRole;
use eos_core::agent::{
    AgentReactions, HostTool, LaunchSpec, ModelCatalog, Peers, ToolSets, UserNotifier, UserQuestions, WorkerControl,
};
use eos_core::browser::BrowserTools;
use eos_core::capability::CapabilityCalls;
use eos_core::experience::ExperienceSearch;
use eos_core::forge::Forge;
use eos_core::os::TimeZone;
use eos_core::pages::PageEditor;
use eos_core::plugin::Plugins;
use eos_core::profile::{MemorySearch, MemorySuggestions};
use eos_core::routine::{ArchitectTools, ChatRoutines, RoutineTools};
use eos_core::store::Store;
use eos_core::surface::SurfaceTools;
use eos_core::transfer::AgentTransfers;
use eos_core::{Clock, Sleeper};
use eos_domain::run_scope::RunRole;
use eos_prompts::PromptRegistry;
use eos_prompts::tool_descriptions::render_tool_descriptions;
use eos_workers::WorkerDefinitions;

use crate::control::Control;
use crate::tool::{Bound, Spec};
use crate::visual::Visual;
use crate::{
    architect, browser, capabilities, control, forge, memory, pages, peers, plugins, reactions, routines, surfaces,
    time, transfer, user, visual,
};

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
    /// What Eos learned from work, as an agent recalls it.
    pub experience: Option<Arc<dyn ExperienceSearch>>,
    pub plugins: Arc<dyn Plugins>,
    pub browser: Option<Arc<dyn BrowserTools>>,
    pub visual: Option<Visual>,
    pub peers: Option<Arc<dyn Peers>>,
    pub transfers: Option<Arc<dyn AgentTransfers>>,
    pub reactions: Option<Arc<dyn AgentReactions>>,
    /// What Eos can reach for the user: GitHub, Mail, the packages installed.
    pub capabilities: Option<Arc<dyn CapabilityCalls>>,
    /// Routines: the tools of a run's sessions.
    pub routines: Option<Arc<dyn RoutineTools>>,
    /// Routines: the tools of a routine's architect.
    pub architect: Option<Arc<dyn ArchitectTools>>,
    /// Routines from a chat: list them, start or propose a run.
    pub chat_routines: Option<Arc<dyn ChatRoutines>>,
    /// Surfaces: a run hands back a View.
    pub surfaces: Option<Arc<dyn SurfaceTools>>,
    /// The Forge: a capability asked for, and its sessions' reports.
    pub forge: Option<Arc<dyn Forge>>,
}

impl std::fmt::Debug for Services {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Services").finish_non_exhaustive()
    }
}

/// A tool as sessions are handed it, with the description it was built from.
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
    /// A routine run's lead: its run tools, `ask_user`, the date, memory
    /// search and the capability tools; none of a chat's.
    pub(crate) run_lead: Vec<Spec>,
    /// A team's lead: a lead's tools and those of its team.
    pub(crate) run_team_lead: Vec<Spec>,
    /// A routine run's checker: its verdict, the date, memory search and the
    /// capability tools.
    pub(crate) run_checker: Vec<Spec>,
    /// A design run's designer: its page tools, its progress, result and
    /// failure, the date and memory search; neither a page's fill nor a
    /// View, nor any capability.
    pub(crate) run_designer: Vec<Spec>,
    /// A routine's architect: its own tools, `list_capabilities` and
    /// `request_capability`.
    pub(crate) architect: Vec<Spec>,
    /// A session of the Forge: its report to the lead, its report to Eos and
    /// the date; nothing that reaches a capability, a page or memory.
    pub(crate) run_forge: Vec<Spec>,
    /// An App's reviewer: its verdict and the date; nothing that reaches a
    /// capability, a page, memory or the user.
    pub(crate) app_reviewer: Vec<Spec>,
    /// The tools handed out so far. A description is rendered anew for each
    /// session (an edited prompt reaches the next one); the tool is rebuilt
    /// only when its description changed. A name is one tool whichever list
    /// holds it. Bounded by the registry's size.
    handed: Mutex<HashMap<&'static str, Handed>>,
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
            list.extend(memory::specs(&s.memory_search, &s.memory_suggestions, s.experience.as_ref()));
            if let Some(browser) = &s.browser {
                list.extend(browser::specs(browser));
            }
            if let Some(calls) = &s.capabilities {
                list.extend(capabilities::specs(calls));
            }
            list
        };
        let visual = || s.visual.as_ref().map(|v| visual::specs(v, &s.clock)).unwrap_or_default();
        // The chats the user talks to: they react to each other's messages.
        let reactions = || s.reactions.as_ref().map(reactions::specs).unwrap_or_default();

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
        orchestrator.extend(reactions());
        // A chat's routines, after everything the chat had before them.
        let chat_routines = || {
            s.chat_routines.as_ref().map(|c| vec![routines::run_spec(c), routines::list_spec(c)]).unwrap_or_default()
        };
        orchestrator.extend(chat_routines());
        let request_capability = || s.forge.as_ref().map(forge::request_spec);
        orchestrator.extend(request_capability());

        let mut worker = vec![control::send_message_to_parent(&c), time::spec(&s.clock, &s.zone)];
        worker.extend(shared());
        worker.extend(plugins::specs(&s.plugins));

        let peer = s.peers.as_ref().map(peers::specs).unwrap_or_default();

        let mut focused = Vec::new();
        if let Some(transfers) = &s.transfers {
            focused.push(transfer::spec(transfers, &s.clock, &s.sleeper));
        }
        focused.extend(visual());
        focused.extend(reactions());
        focused.extend(chat_routines());

        // What every run session has besides its own tools.
        let run_shared = || {
            let mut list = vec![time::spec(&s.clock, &s.zone)];
            list.extend(
                memory::specs(&s.memory_search, &s.memory_suggestions, None)
                    .into_iter()
                    .filter(|t| t.name == "search_memory"),
            );
            if let Some(calls) = &s.capabilities {
                list.extend(capabilities::specs(calls));
            }
            list
        };
        let lead = || s.routines.as_ref().map(routines::lead_specs).unwrap_or_default();
        let mut run_lead = lead();
        let mut run_team_lead = lead();
        run_team_lead.extend(s.routines.as_ref().map(routines::team_specs).unwrap_or_default());
        for list in [&mut run_lead, &mut run_team_lead] {
            list.extend(s.surfaces.as_ref().map(surfaces::specs).unwrap_or_default());
            list.push(user::ask_user(&s.questions));
            list.extend(run_shared());
        }
        let mut run_designer = s.surfaces.as_ref().map(surfaces::designer_specs).unwrap_or_default();
        run_designer.extend(lead());
        let reaches_capabilities = |t: &Spec| t.name == "list_capabilities" || t.name == "call_capability";
        run_designer.extend(run_shared().into_iter().filter(|t| !reaches_capabilities(t)));
        // Eos starts no checker; a checker session in the data reads only what every run session does.
        let run_checker = run_shared();

        let mut architect = s.architect.as_ref().map(architect::specs).unwrap_or_default();
        if let Some(calls) = &s.capabilities {
            architect.extend(capabilities::specs(calls).into_iter().filter(|t| t.name == "list_capabilities"));
        }
        architect.extend(request_capability());
        architect.extend(s.chat_routines.as_ref().map(routines::list_spec));

        let mut run_forge = vec![control::send_message_to_parent(&c)];
        run_forge.extend(s.forge.as_ref().map(forge::report_spec));
        run_forge.push(time::spec(&s.clock, &s.zone));

        let mut app_reviewer: Vec<Spec> = s.surfaces.as_ref().map(surfaces::reviewer_spec).into_iter().collect();
        app_reviewer.push(time::spec(&s.clock, &s.zone));

        Self {
            prompts: s.prompts,
            plugins: s.plugins,
            orchestrator,
            worker,
            peer,
            focused,
            run_lead,
            run_team_lead,
            run_checker,
            run_designer,
            architect,
            run_forge,
            app_reviewer,
            handed: Mutex::default(),
        }
    }

    /// The registry entries a session of this kind gets, in order.
    fn listed(&self, spec: &LaunchSpec) -> Vec<&Spec> {
        let off = self.plugins.disabled_builtins();
        let on = |tool: &&Spec| tool.plugin.is_none_or(|plugin| !off.iter().any(|id| id == plugin));
        if spec.role == SessionFactsRole::Orchestrator {
            return self.orchestrator.iter().filter(on).collect();
        }
        // A run's sessions are keyed on their reserved definition, never on the role alone.
        match spec.worker_definition.as_deref() {
            Some(routines::TEAM_LEAD_DEFINITION) => return self.run_team_lead.iter().filter(on).collect(),
            Some(name) if routines::LEAD_DEFINITIONS.contains(&name) => {
                return self.run_lead.iter().filter(on).collect();
            }
            Some(routines::CHECKER_DEFINITION) => return self.run_checker.iter().filter(on).collect(),
            Some(routines::DESIGNER_DEFINITION) => return self.run_designer.iter().filter(on).collect(),
            Some(routines::APP_REVIEWER_DEFINITION) => return self.app_reviewer.iter().filter(on).collect(),
            Some(architect::ARCHITECT_DEFINITION) => return self.architect.iter().filter(on).collect(),
            Some(name) if RunRole::of_forge_definition(name).is_some() => {
                return self.run_forge.iter().filter(on).collect();
            }
            _ => {}
        }
        let mut list: Vec<&Spec> = self.worker.iter().collect();
        if spec.collaborate {
            list.extend(&self.peer);
        }
        if spec.role == SessionFactsRole::Focused {
            list.extend(&self.focused);
        }
        list.retain(on);
        list
    }
}

impl ToolSets for Tools {
    fn for_session(&self, spec: &LaunchSpec) -> Vec<Arc<dyn HostTool>> {
        let list = self.listed(spec);
        let names: Vec<&str> = list.iter().map(|tool| tool.name).collect();
        // An edited prompt file reaches the next session.
        self.prompts.reload();
        let descriptions = render_tool_descriptions(self.prompts.clone(), &names);
        let mut handed = self.handed.lock().unwrap_or_else(PoisonError::into_inner);
        list.into_iter()
            .zip(descriptions)
            .map(|(tool, (_, description))| {
                let entry = handed.entry(tool.name);
                let kept = entry
                    .and_modify(|had| {
                        if had.description != description {
                            *had = hand(tool, description.clone());
                        }
                    })
                    .or_insert_with(|| hand(tool, description.clone()));
                kept.tool.clone()
            })
            .collect()
    }
}

fn hand(tool: &Spec, description: String) -> Handed {
    Handed { tool: Arc::new(Bound::new(tool, description.clone())), description }
}
