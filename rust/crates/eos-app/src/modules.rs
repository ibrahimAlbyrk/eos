//! Every feature of the app: one line each.

use std::sync::Arc;

use eos_contracts::UiConfigResponseFeatures;
use eos_core::agent::{BackendCatalog, ModelCatalog};
use eos_core::os::ProcessStats;
use eos_core::store::{ConfigSource, ProjectStore, RecentFolders, Store};
use eos_core::{Clock, Ids};
use eos_mod_profile::PendingCaps;
use eos_mod_system::RunInfo;
use eos_runtime::bus::Bus;
use eos_runtime::module::Module;

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
    pub(crate) projects: Arc<dyn ProjectStore>,
    pub(crate) recents: Arc<dyn RecentFolders>,
}

/// The modules, in start order (stop order is the reverse). A feature crate
/// adds its line here, in alphabetical order; nothing else in the app changes.
pub(crate) fn all(cx: &Context) -> Vec<Arc<dyn Module>> {
    vec![
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
        Arc::new(eos_mod_projects::ProjectsModule::new(cx.projects.clone(), cx.recents.clone())),
        Arc::new(eos_mod_system::SystemModule::new(
            cx.run.clone(),
            cx.features.clone(),
            cx.stats.clone(),
            cx.config.clone(),
            cx.models.clone(),
            cx.backends.clone(),
        )),
        Arc::new(eos_mod_workers::WorkersModule::new(cx.store.clone(), cx.models.clone())),
    ]
}
