//! Every feature of the app: one line each.

use std::sync::Arc;

use eos_accounts::Accounts;
use eos_contracts::UiConfigResponseFeatures;
use eos_core::agent::{BackendCatalog, ModelCatalog, ScratchFolders};
use eos_core::os::ProcessStats;
use eos_core::prompt::ProfileRenderer;
use eos_core::shell::Location;
use eos_core::store::{ConfigSource, ProjectStore, RecentFolders, Store, TemplateStore, UserSettingsStore};
use eos_core::{Clock, Ids};
use eos_mod_plugins::PluginHost;
use eos_mod_profile::PendingCaps;
use eos_mod_system::RunInfo;
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
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) notes: Notes,
    pub(crate) run: RunInfo,
    pub(crate) features: UiConfigResponseFeatures,
    pub(crate) stats: Arc<dyn ProcessStats>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) models: Arc<dyn ModelCatalog>,
    pub(crate) backends: Arc<dyn BackendCatalog>,
    pub(crate) sessions: eos_sessions::Sessions,
    pub(crate) projects: Arc<dyn ProjectStore>,
    pub(crate) recents: Arc<dyn RecentFolders>,
    pub(crate) accounts: Arc<Accounts>,
    pub(crate) plugins: Arc<PluginHost>,
    pub(crate) kernel: eos_runtime::Kernel,
    pub(crate) paths: eos_platform::DataPaths,
    /// Routes of the raw-content origin, collected while the modules are built.
    pub(crate) raw_routes: crate::files::RawRoutes,
    /// The folder of the bundled PDF viewer, when the host has one.
    pub(crate) pdfjs_root: Option<std::path::PathBuf>,
    pub(crate) settings: Arc<dyn UserSettingsStore>,
    /// What visual answers fetch: images, the map, geocoding, place search.
    pub(crate) media: eos_genui_media::Services,
    /// The window shell's reading of this computer's position, when there is a shell.
    pub(crate) location: Option<Arc<dyn Location>>,
    pub(crate) policy: Arc<PolicyGateway>,
    pub(crate) profile_prompt: Arc<dyn ProfileRenderer>,
    pub(crate) prompts: Arc<PromptService>,
    pub(crate) templates: Arc<dyn TemplateStore>,
    pub(crate) updates: Arc<crate::updates::Updates>,
    pub(crate) worker_definitions: Arc<WorkerDefinitions>,
    pub(crate) scratch: Arc<dyn ScratchFolders>,
}

/// The modules, in start order (stop order is the reverse). A feature crate
/// adds its line here, in alphabetical order; nothing else in the app changes.
pub(crate) fn all(cx: &Context) -> Vec<Arc<dyn Module>> {
    vec![
        Arc::new(eos_mod_accounts::AccountsModule::new(cx.accounts.clone(), cx.config.clone())),
        Arc::new(eos_mod_agents::AgentsModule::new(
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
        )),
        crate::files::module(cx),
        Arc::new(eos_mod_genui::GenuiModule::new(eos_mod_genui::GenuiParts {
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
        })),
        Arc::new(eos_mod_pages::PagesModule::new(
            cx.notes.pages.clone(),
            cx.store.clone(),
            cx.clock.clone(),
            cx.ids.clone(),
            cx.bus.clone(),
        )),
        Arc::new(eos_mod_profile::ProfileModule::new(
            cx.notes.profile.clone(),
            cx.notes.preview.clone(),
            PendingCaps::default(),
            cx.clock.clone(),
            cx.ids.clone(),
            cx.bus.clone(),
        )),
        cx.plugins.module(),
        Arc::new(eos_mod_policy::PolicyModule::new(cx.policy.clone(), cx.store.clone(), cx.bus.clone())),
        Arc::new(eos_mod_projects::ProjectsModule::new(cx.projects.clone(), cx.recents.clone())),
        Arc::new(eos_mod_prompts::PromptsModule::new(cx.prompts.clone(), Some(cx.profile_prompt.clone()))),
        Arc::new(eos_mod_system::SystemModule::new(
            cx.run.clone(),
            cx.features.clone(),
            cx.stats.clone(),
            cx.config.clone(),
            cx.models.clone(),
            cx.backends.clone(),
        )),
        Arc::new(eos_mod_templates::TemplatesModule::new(cx.templates.clone())),
        cx.updates.module(cx.config.clone(), &cx.kernel),
        Arc::new(eos_mod_worker_definitions::WorkerDefinitionsModule::new(
            cx.worker_definitions.clone(),
            cx.bus.clone(),
        )),
        Arc::new(eos_mod_workers::WorkersModule::new(cx.store.clone(), cx.models.clone())),
    ]
}
