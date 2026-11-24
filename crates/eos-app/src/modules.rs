//! Every feature of the app: one line each.

use std::sync::Arc;

use eos_accounts::Accounts;
use eos_contracts::UiConfigResponseFeatures;
use eos_core::agent::{BackendCatalog, ModelCatalog, OneShot, ScratchFolders, ToolSets, WorkflowRunFiles};
use eos_core::os::ProcessStats;
use eos_core::prompt::ProfileRenderer;
use eos_core::shell::Location;
use eos_core::store::{ConfigSource, ProjectStore, RecentFolders, Store, TemplateStore, UserSettingsStore};
use eos_core::terminal::{ClaudeLaunchEnv, ClaudeProgram, ClaudeTranscripts, ShellCommands, Terminals};
use eos_core::workers::ListedWorkers;
use eos_core::{Clock, Ids, Sleeper};
use eos_mod_plugins::PluginHost;
use eos_mod_profile::PendingCaps;
use eos_mod_system::RunInfo;
use eos_mod_terminals::{RunDeps, SessionDeps};
use eos_policy::PolicyGateway;
use eos_prompts::PromptService;
use eos_runtime::bus::Bus;
use eos_runtime::module::Module;
use eos_workers::WorkerDefinitions;

use crate::notes::Notes;

/// What features are built from. A module's constructor takes the parts it
/// uses (never this struct: feature crates cannot see `eos-app`).
pub(crate) struct Context {
    pub(crate) bus: Bus,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) sleeper: Arc<dyn Sleeper>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) notes: Notes,
    pub(crate) run: RunInfo,
    pub(crate) features: UiConfigResponseFeatures,
    pub(crate) stats: Arc<dyn ProcessStats>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) models: Arc<dyn ModelCatalog>,
    pub(crate) backends: Arc<dyn BackendCatalog>,
    /// The keys of the providers reached with an API key.
    pub(crate) provider_keys: Arc<dyn eos_core::agent::ProviderKeys>,
    /// The skills and slash commands of a folder, as the engine finds them.
    pub(crate) commands: Arc<dyn eos_core::agent::CommandCatalog>,
    /// The model, asked once outside any conversation (summaries, titles, dreams).
    pub(crate) one_shot: Arc<dyn OneShot>,
    /// The workflow run records and agent conversations the engine keeps.
    pub(crate) workflow_files: Arc<dyn WorkflowRunFiles>,
    pub(crate) sessions: eos_sessions::Sessions,
    pub(crate) projects: Arc<dyn ProjectStore>,
    /// The links between this computer and the ones paired with it.
    pub(crate) peer: crate::peer::Peer,
    /// How a project folder is named between computers.
    pub(crate) project_keys: Arc<dyn eos_core::git::ProjectKeys>,
    pub(crate) questions: eos_mod_questions::Questions,
    /// The questions every session asks through: a routine run's in Needs you.
    pub(crate) run_questions: eos_inbox::RunQuestions,
    pub(crate) recents: Arc<dyn RecentFolders>,
    pub(crate) accounts: Arc<Accounts>,
    /// Each Claude sign-in's claude.ai Artifacts.
    pub(crate) artifacts: Arc<dyn eos_core::net::ArtifactSource>,
    pub(crate) browser: Arc<eos_mod_browser::BrowserModule>,
    /// The shell's open panel, when there is a window.
    pub(crate) picker: Option<Arc<dyn eos_core::shell::FilePicker>>,
    /// The shell's secret prompt, when there is a window.
    pub(crate) secret_prompt: Option<Arc<dyn eos_core::shell::SecretPrompt>>,
    pub(crate) plugins: Arc<PluginHost>,
    pub(crate) kernel: eos_runtime::Kernel,
    pub(crate) paths: eos_platform::DataPaths,
    /// Routes of the raw-content origin, collected while the modules are built.
    pub(crate) raw_routes: crate::files::RawRoutes,
    /// The shell's page probe, which checks page designs.
    pub(crate) page_probe: Arc<dyn eos_core::surface::PageProbe>,
    /// The shell's page printer, which prints page issues to PDF.
    pub(crate) page_printer: Arc<dyn eos_core::surface::PagePrinter>,
    /// The folder of the bundled PDF viewer, when the host has one.
    pub(crate) pdfjs_root: Option<std::path::PathBuf>,
    /// The folder of memory's meaning model, when this run has one.
    pub(crate) embed_model: Option<std::path::PathBuf>,
    pub(crate) settings: Arc<dyn UserSettingsStore>,
    /// Keeps the app working while routines run or wait: the window shell's, else the
    /// system's own way.
    pub(crate) work_hold: Arc<dyn eos_core::os::WorkHold>,
    /// The Dock icon's number: the window shell's, else none.
    pub(crate) dock_badge: Arc<dyn eos_core::os::DockBadge>,
    /// The plan usage the accounts feature last fetched.
    pub(crate) usage_cache: Arc<dyn eos_core::accounts::UsageSnapshotStore>,
    /// What visual answers fetch: images, the map, geocoding, place search.
    pub(crate) media: eos_genui_media::Services,
    /// The window shell's reading of this computer's position, when there is a shell.
    pub(crate) location: Option<Arc<dyn Location>>,
    pub(crate) policy: Arc<PolicyGateway>,
    /// What Eos can reach for the user: the agent tools, the gateway and its feature share it.
    pub(crate) capabilities: Arc<eos_capabilities::CapabilityService>,
    /// The engine's sandbox, which capability code and the Forge's tests run under.
    pub(crate) confinement: Arc<crate::capabilities::LateConfinement>,
    /// The sources routines read: the built-ins', or a test's.
    pub(crate) signal_sources: Arc<dyn eos_core::signals::SignalSources>,
    /// The channels results go out through: the built-ins', or a test's.
    pub(crate) channels: Arc<dyn eos_core::delivery::Channels>,
    /// Where the routines feature's grant to run sessions is attached.
    pub(crate) grants: Arc<crate::capabilities::LateGrants>,
    /// Where the routines feature's kept scripts are attached for the gateway.
    pub(crate) scripts: Arc<crate::scripts::LateScripts>,
    pub(crate) profile_prompt: Arc<dyn ProfileRenderer>,
    pub(crate) prompts: Arc<PromptService>,
    pub(crate) templates: Arc<dyn TemplateStore>,
    /// Where the agent tools are attached once the features they call are built.
    pub(crate) tools: Arc<crate::agent::LateTools>,
    pub(crate) updates: Arc<crate::updates::Updates>,
    pub(crate) worker_definitions: Arc<WorkerDefinitions>,
    pub(crate) scratch: Arc<dyn ScratchFolders>,
    /// Try: workers' work shown in the user's checkouts.
    pub(crate) tries: Arc<dyn eos_core::git::BranchIntegration>,
    /// Claude Code's memory of the projects workers work in.
    pub(crate) project_memory: Arc<dyn eos_core::store::ProjectMemoryStore>,
    pub(crate) git_watcher: Arc<dyn eos_core::git::GitWatcher>,
    pub(crate) file_watcher: Arc<dyn eos_core::os::FileWatcher>,
    /// git: the kept working-tree snapshots and the adapter whose writes tell them.
    pub(crate) repos: crate::files::Repos,
    /// The app works on the user's own data folder: it may delete on its own.
    pub(crate) sweep_leftovers: bool,
    /// What this run may do as the user beyond this computer.
    pub(crate) reach: crate::reach::Reach,
    /// How the relay's hook inbox is reached, when the host handed it in.
    pub(crate) hook_client: Option<eos_relay::HookClient>,
    pub(crate) terminals: Terminal,
    /// The phone link. Built ahead of the rest: the app hands it the router afterwards.
    pub(crate) remote: Arc<eos_mod_remote::RemoteModule>,
    /// The boot snapshot. Built ahead of the rest: the app hands it the router afterwards.
    pub(crate) boot: Arc<eos_mod_boot::BootModule>,
}

/// What terminals run on: the PTY, the user's shell and their Claude Code.
pub(crate) struct Terminal {
    pub(crate) ptys: Arc<dyn Terminals>,
    pub(crate) commands: Arc<dyn ShellCommands>,
    pub(crate) claude: Arc<dyn ClaudeProgram>,
    pub(crate) claude_env: Arc<dyn ClaudeLaunchEnv>,
    /// Whether a new Claude pane gets memory's hooks (04 G34).
    pub(crate) pane_hooks: Arc<dyn eos_core::terminal::PaneHooks>,
    pub(crate) transcripts: Arc<dyn ClaudeTranscripts>,
    /// Where a terminal opens when the dashboard names no folder.
    pub(crate) default_cwd: String,
}

/// What the app is made of besides the kernel.
pub(crate) struct Features {
    /// In start order (stop order is the reverse).
    pub(crate) modules: Vec<Arc<dyn Module>>,
    /// Eos's agent tools, which the engine holds weakly.
    pub(crate) tools: Arc<dyn ToolSets>,
    /// The rows of `GET /workers` by id, full and brief: what the row patches read.
    pub(crate) worker_rows: Arc<dyn ListedWorkers>,
    pub(crate) brief_worker_rows: Arc<dyn ListedWorkers>,
    /// Where a sign-in's `eos://sign-in/<id>` link goes.
    pub(crate) sign_in_links: eos_mod_capabilities::SignInLinks,
}

/// The modules and the agent tools over them. A feature crate adds its line
/// here, in alphabetical order; nothing else in the app changes.
pub(crate) fn all(cx: &Context) -> Result<Features, crate::Error> {
    // The features the agent tools call are built first: the tools hold them.
    let agents = Arc::new(
        eos_mod_agents::AgentsModule::new(
            cx.sessions.clone(),
            cx.store.clone(),
            cx.ids.clone(),
            cx.worker_definitions.clone(),
            eos_mod_agents::Spawning {
                config: cx.config.clone(),
                settings: cx.settings.clone(),
                prompts: cx.prompts.clone(),
                scratch: cx.scratch.clone(),
            },
            crate::files::worker_git(cx),
        )
        .sweeping_archives(cx.sweep_leftovers)
        .watching(eos_mod_agents::Watch {
            bus: cx.bus.clone(),
            jobs: cx.kernel.jobs.clone(),
            git_watcher: cx.git_watcher.clone(),
            models: cx.models.clone(),
        }),
    );
    let pages = Arc::new(eos_mod_pages::PagesModule::new(
        cx.notes.pages.clone(),
        cx.store.clone(),
        cx.clock.clone(),
        cx.ids.clone(),
        cx.bus.clone(),
    ));
    let profile = Arc::new(
        eos_mod_profile::ProfileModule::new(
            cx.notes.profile.clone(),
            cx.notes.preview.clone(),
            PendingCaps::default(),
            cx.clock.clone(),
            cx.ids.clone(),
            cx.bus.clone(),
        )
        .with_avatar_thumbnails(cx.notes.avatar_thumbnails.clone()),
    );
    let genui = Arc::new(eos_mod_genui::GenuiModule::new(eos_mod_genui::GenuiParts {
        store: cx.store.clone(),
        settings: cx.settings.clone(),
        config: cx.config.clone(),
        clock: cx.clock.clone(),
        ids: cx.ids.clone(),
        bus: cx.bus.clone(),
        media: cx.media.media.clone(),
        map: cx.media.map.clone(),
        geocoder: cx.media.geocoder.clone(),
        place_search: cx.media.places.clone(),
        location: cx.location.clone(),
    }));
    let channels = cx.reach.channels(cx.channels.clone());
    let gate =
        Arc::new(eos_inbox::gate::Gate::new(channels.clone(), Arc::new(crate::host::HostTimeZone), cx.clock.clone()));
    let power: Arc<dyn eos_core::os::Power> =
        Arc::new(crate::host::HostPower { cache: eos_platform::PowerCache::new(), clock: cx.clock.clone() });
    // Memory asks routines which run a worker works for; routines ask memory
    // for packs. Memory is built first and finds routines once they exist.
    let runs = Arc::new(crate::memory::LateRuns::default());
    let memory = crate::memory::module(
        cx,
        runs.clone(),
        profile.profile_reader(),
        profile.memory_keeper(),
        profile.memory_reader(),
    );
    let forge_steps = Arc::new(eos_mod_forge::ForgeSteps::new(eos_mod_forge::ForgeStepsParts {
        store: cx.store.clone(),
        clock: cx.clock.clone(),
        ids: cx.ids.clone(),
        zone: Arc::new(crate::host::HostTimeZone),
        files: Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), &cx.paths)),
        scratch: cx.paths.join("scratch"),
        trial: Arc::new(eos_capability_host::Trial::new(
            cx.confinement.clone(),
            eos_kit_proc::Runner::new(eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
                eos_platform::kill_process_tree(pid).is_ok()
            })),
            cx.ids.clone(),
        )),
    }));
    let routines = Arc::new(eos_mod_routines::RoutinesModule::new(eos_mod_routines::RoutinesParts {
        store: cx.store.clone(),
        clock: cx.clock.clone(),
        sleeper: cx.sleeper.clone(),
        ids: cx.ids.clone(),
        device: cx.peer.device_id(),
        autostart: cx.reach.autostart(),
        background_model_calls: cx.reach.background_model_calls(),
        sessions: cx.sessions.clone(),
        prompts: cx.prompts.clone(),
        scratch: cx.scratch.clone(),
        folders: Arc::new(eos_store_files::run_folders::FsRunFolders::new(cx.paths.join("routines"))),
        data_dir: cx.paths.home().to_owned(),
        reads: cx.capabilities.clone(),
        gate: gate.clone(),
        config: cx.config.clone(),
        keys: cx.project_keys.clone(),
        remotes: cx.repos.git.clone(),
        bus: cx.bus.clone(),
        zones: Arc::new(crate::host::HostZoneRules),
        zone: Arc::new(crate::host::HostTimeZone),
        settings: cx.settings.clone(),
        headroom: Arc::new(crate::headroom::CachedHeadroom { cache: cx.usage_cache.clone(), clock: cx.clock.clone() }),
        one_shot: cx.one_shot.clone(),
        power: power.clone(),
        trash: Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), &cx.paths)),
        packs: memory.experience_packs(),
        feedback: memory.experience_feedback(),
        surfaces: Arc::new(eos_mod_surfaces::SurfaceAuthor::new(
            cx.store.clone(),
            cx.clock.clone(),
            cx.ids.clone(),
            Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), &cx.paths)),
            cx.paths.join("surfaces"),
        )),
        system_steps: forge_steps.clone(),
    }));
    runs.attach(&routines);
    forge_steps.attach(routines.control());
    cx.grants.attach(&routines.grants());
    cx.scripts.attach(&routines.scripts());
    // The delivery engine keeps the outcomes alive for the gate.
    let run_outcomes = routines.outcomes();
    gate.attach(&routines.control(), &run_outcomes);
    cx.run_questions.attach(&routines.control());
    let surfaces = Arc::new(eos_mod_surfaces::SurfacesModule::new(eos_mod_surfaces::SurfacesParts {
        store: cx.store.clone(),
        clock: cx.clock.clone(),
        ids: cx.ids.clone(),
        settings: cx.settings.clone(),
        actions: cx.kernel.actions.clone(),
        gate: Arc::new(eos_inbox::gate::DirectActionGate::new(eos_inbox::gate::ActionGateParts {
            store: cx.store.clone(),
            clock: cx.clock.clone(),
            ids: cx.ids.clone(),
            zone: Arc::new(crate::host::HostTimeZone),
            control: routines.control(),
        })),
        cards: Arc::new(cx.run_questions.clone()),
        images: Arc::new(eos_store_files::surface_images::FileSurfaceImages::new(
            cx.paths.join("surfaces"),
            cx.media.media.clone(),
        )),
        zone: Arc::new(crate::host::HostTimeZone),
        profile: cx.notes.profile.profile.clone(),
        feedback: memory.experience_feedback(),
        runs: routines.runs(),
        probe: cx.page_probe.clone(),
        printer: cx.page_printer.clone(),
        root: cx.paths.join("surfaces"),
    }));
    cx.raw_routes.add(surfaces.raw_routes());
    // The mail channel draws a page issue it sends.
    cx.capabilities.attach_render(surfaces.render());
    let forge = Arc::new(eos_mod_forge::ForgeModule::new(eos_mod_forge::ForgeParts {
        store: cx.store.clone(),
        clock: cx.clock.clone(),
        runs: routines.runs(),
        builtins: routines.builtins(),
        capabilities: cx.capabilities.clone(),
        definitions: eos_workers::definition::records_from(&eos_store_files::worker_definitions::forge_definitions()),
        steps: forge_steps,
        service: cx.capabilities.clone(),
        prompt: cx.secret_prompt.clone(),
        bus: cx.bus.clone(),
    }));
    let transfer = crate::machines::transfer(cx);
    let tools: Arc<dyn ToolSets> =
        crate::tools::build(cx, &agents, &genui, &pages, &profile, &transfer, &routines, &memory, &surfaces, &forge)?;
    cx.tools.attach(&tools);
    let workers = Arc::new(
        eos_mod_workers::WorkersModule::new(cx.store.clone(), cx.models.clone(), cx.clock.clone())
            .with_open_questions(Arc::new(cx.questions.clone()))
            .with_project_memory(cx.project_memory.clone()),
    );
    let (worker_rows, brief_worker_rows) = (workers.listed_rows(false), workers.listed_rows(true));

    let capabilities = Arc::new(
        eos_mod_capabilities::CapabilitiesModule::new(
            cx.capabilities.clone(),
            cx.store.clone(),
            cx.clock.clone(),
            cx.sleeper.clone(),
        )
        .with_secret_prompt(cx.secret_prompt.clone()),
    );
    let sign_in_links = capabilities.sign_in_links();
    let mut modules: Vec<Arc<dyn Module>> = vec![
        Arc::new(eos_mod_accounts::AccountsModule::new(
            cx.accounts.clone(),
            cx.config.clone(),
            cx.provider_keys.clone(),
        )),
        Arc::new(eos_mod_agent_jobs::AgentJobsModule::new(cx.kernel.jobs.clone(), Arc::new(cx.sessions.clone()))),
        agents,
        Arc::new(eos_mod_artifacts::ArtifactsModule::new(eos_mod_artifacts::Parts {
            source: cx.artifacts.clone(),
            access: cx.accounts.clone(),
            clock: cx.clock.clone(),
            sleeper: cx.sleeper.clone(),
            lane: cx.kernel.ordered.clone(),
            bus: cx.bus.clone(),
        })),
        Arc::new(eos_mod_auto_name::AutoNameModule::new(
            eos_mod_auto_name::RunnerParts {
                bus: cx.bus.clone(),
                one_shot: cx.one_shot.clone(),
                prompts: cx.prompts.clone(),
                config: cx.config.clone(),
                plugins: cx.plugins.switch(),
                clock: cx.clock.clone(),
                sleeper: cx.sleeper.clone(),
            },
            cx.store.clone(),
        )),
        cx.boot.clone(),
        Arc::new(eos_mod_btw::BtwModule::new(cx.store.clone(), Arc::new(cx.sessions.clone()))),
        capabilities.clone(),
        Arc::new(eos_mod_compaction::CompactionModule::new(eos_mod_compaction::Parts {
            store: cx.store.clone(),
            sessions: Arc::new(cx.sessions.clone()),
            clock: cx.clock.clone(),
            jobs: cx.kernel.jobs.clone(),
        })),
        Arc::new(eos_mod_dreams::DreamsModule::new(
            eos_mod_dreams::DreamParts {
                store: cx.store.clone(),
                one_shot: cx.one_shot.clone(),
                prompts: cx.prompts.clone(),
                memories: profile.memory_reader(),
                suggestions: profile.suggestion_sink(),
                profile: profile.profile_reader(),
                profile_text: cx.profile_prompt.clone(),
                config: cx.config.clone(),
                clock: cx.clock.clone(),
                ids: cx.ids.clone(),
                zone: Arc::new(crate::host::HostTimeZone),
            },
            cx.accounts.clone(),
            cx.bus.clone(),
            cx.kernel.jobs.clone(),
            cx.sleeper.clone(),
        )),
        cx.browser.clone(),
        crate::files::module(cx),
        forge,
        genui,
        Arc::new(eos_mod_inbox::InboxModule::new(eos_mod_inbox::InboxParts {
            store: cx.store.clone(),
            clock: cx.clock.clone(),
            bus: cx.bus.clone(),
            questions: Arc::new(cx.questions.clone()),
            memories: profile.memory_reader(),
            waiters: cx.run_questions.waiters(),
            delivery: eos_inbox::delivery::DeliveryParts {
                store: cx.store.clone(),
                clock: cx.clock.clone(),
                sleeper: cx.sleeper.clone(),
                ids: cx.ids.clone(),
                zone: Arc::new(crate::host::HostTimeZone),
                channels,
                control: routines.control(),
                outcomes: run_outcomes,
                wake: gate.waker(),
            },
            config: cx.config.clone(),
            phone: cx.reach.phone_notify(cx.remote.phone_notify()),
            badge: cx.dock_badge.clone(),
        })),
        memory,
        pages,
        cx.peer.module(),
        profile,
        cx.plugins.module(),
        Arc::new(eos_mod_policy::PolicyModule::new(cx.policy.clone(), cx.store.clone(), cx.bus.clone())),
        Arc::new(eos_mod_projects::ProjectsModule::new(cx.projects.clone(), cx.recents.clone())),
        Arc::new(eos_mod_prompts::PromptsModule::new(cx.prompts.clone(), Some(cx.profile_prompt.clone()))),
        Arc::new(eos_mod_questions::QuestionsModule::new(cx.questions.clone())),
        Arc::new(eos_mod_reactions::ReactionsModule::new(cx.sessions.clone())),
        cx.remote.clone(),
        routines.clone(),
        Arc::new(eos_mod_signals::SignalsModule::new(eos_mod_signals::SignalsParts {
            store: cx.store.clone(),
            clock: cx.clock.clone(),
            sleeper: cx.sleeper.clone(),
            ids: cx.ids.clone(),
            zones: Arc::new(crate::host::HostZoneRules),
            sources: cx.reach.signal_sources(cx.signal_sources.clone()),
            hooks: cx.hook_client.as_ref().and_then(|client| cx.reach.hook_inbox(|| hook_inbox(cx, client))),
            health: cx.capabilities.clone(),
            runner: Arc::new(eos_mod_signals::SoloRunner::new(cx.peer.device_id())),
            intake: routines.intake(),
            directory: routines.directory(),
            control: routines.control(),
            zone: Arc::new(crate::host::HostTimeZone),
            bus: cx.bus.clone(),
            hold: cx.work_hold.clone(),
            power,
            settings: cx.settings.clone(),
            one_shot: cx.one_shot.clone(),
            prompts: cx.prompts.clone(),
            config: cx.config.clone(),
            files: cx.file_watcher.clone(),
            git: cx.git_watcher.clone(),
            git_info: cx.repos.snapshots.clone(),
            disk: Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), &cx.paths)),
            data_dir: cx.paths.home().to_owned(),
            autostart: cx.reach.autostart(),
        })),
        surfaces.clone(),
        Arc::new(eos_mod_system::SystemModule::new(
            cx.run.clone(),
            cx.features.clone(),
            cx.stats.clone(),
            cx.config.clone(),
            eos_mod_system::Offers {
                models: cx.models.clone(),
                backends: cx.backends.clone(),
                commands: cx.commands.clone(),
            },
            eos_mod_system::LocalClock { clock: cx.clock.clone(), zone: Arc::new(crate::host::HostTimeZone) },
        )),
        Arc::new(eos_mod_templates::TemplatesModule::new(cx.templates.clone())),
        Arc::new(eos_mod_terminals::TerminalsModule::new(
            SessionDeps {
                terminals: cx.terminals.ptys.clone(),
                claude: cx.terminals.claude.clone(),
                claude_env: cx.terminals.claude_env.clone(),
                pane_hooks: cx.terminals.pane_hooks.clone(),
                bus: cx.bus.clone(),
                ids: cx.ids.clone(),
                clock: cx.clock.clone(),
                default_cwd: cx.terminals.default_cwd.clone(),
            },
            cx.terminals.transcripts.clone(),
            RunDeps {
                commands: cx.terminals.commands.clone(),
                store: cx.store.clone(),
                bus: cx.bus.clone(),
                jobs: cx.kernel.jobs.clone(),
                clock: cx.clock.clone(),
                ids: cx.ids.clone(),
            },
        )),
        transfer,
        cx.updates.module(cx.config.clone(), &cx.kernel),
        Arc::new(eos_mod_worker_definitions::WorkerDefinitionsModule::new(cx.worker_definitions.clone())),
        workers,
        Arc::new(eos_mod_workflow_runs::WorkflowRunsModule::new(eos_mod_workflow_runs::Parts {
            store: cx.store.clone(),
            sessions: Arc::new(cx.sessions.clone()),
            files: cx.workflow_files.clone(),
            bus: cx.bus.clone(),
            jobs: cx.kernel.jobs.clone(),
            clock: cx.clock.clone(),
            sleeper: cx.sleeper.clone(),
        })),
    ];
    // Settings refuses the keys the features above set through routes of their own.
    let protected = modules.iter().filter_map(|module| module.protected_settings()).collect();
    modules.push(Arc::new(eos_mod_settings::SettingsModule::new(
        cx.settings.clone(),
        cx.config.clone(),
        Arc::new(cx.sessions.clone()),
        protected,
    )));
    // Sync is built from what the features above let follow the user.
    let contributions = modules.iter().flat_map(|module| module.sync()).collect();
    modules.push(crate::machines::sync(cx, contributions)?);
    Ok(Features { modules, tools, worker_rows, brief_worker_rows, sign_in_links })
}

/// The hook inbox on the phone link's relay, under the identity kept in
/// `remote/hooks.json`.
fn hook_inbox(cx: &Context, client: &eos_relay::HookClient) -> Arc<dyn eos_core::net::hooks::HookInbox> {
    let config = cx.config.clone();
    Arc::new(client.inbox(
        Arc::new(move || config.current().remote.relay.as_ref().map(|relay| relay.url.clone())),
        Arc::new(eos_store_files::remote::RemoteFiles::new(cx.paths.join("remote"))),
    ))
}
