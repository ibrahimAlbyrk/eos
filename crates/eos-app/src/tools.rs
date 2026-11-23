//! Eos's own tools for agents: the registry over the features it calls.

use std::sync::Arc;

use eos_mod_agents::{AgentsModule, ToolControl};
use eos_mod_genui::GenuiModule;
use eos_mod_memory::MemoryModule;
use eos_mod_pages::PagesModule;
use eos_mod_profile::ProfileModule;
use eos_mod_routines::RoutinesModule;
use eos_mod_transfer::TransferModule;
use eos_tools::{Services, Tools, Visual};

use crate::host::HostTimeZone;
use crate::modules::Context;

/// The registry: Eos's own tools over the features they call.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build(
    cx: &Context,
    agents: &AgentsModule,
    genui: &GenuiModule,
    pages: &PagesModule,
    profile: &ProfileModule,
    transfer: &TransferModule,
    routines: &RoutinesModule,
    memory: &MemoryModule,
    surfaces: &eos_mod_surfaces::SurfacesModule,
) -> Result<Arc<Tools>, eos_runtime::Error> {
    let questions = Arc::new(cx.questions.clone());
    let control = Arc::new(ToolControl::new(agents)?);
    Ok(Arc::new(Tools::new(Services {
        prompts: cx.prompts.registry().clone(),
        clock: cx.clock.clone(),
        sleeper: cx.sleeper.clone(),
        zone: Arc::new(HostTimeZone),
        store: cx.store.clone(),
        models: cx.models.clone(),
        definitions: cx.worker_definitions.clone(),
        workers: control.clone(),
        notifier: questions,
        questions: Arc::new(cx.run_questions.clone()),
        pages: pages.editor(),
        memory_search: profile.memory_search(),
        memory_suggestions: profile.memory_suggestions(),
        experience: Some(memory.experience_search()),
        plugins: cx.plugins.clone(),
        browser: Some(cx.browser.tools()),
        visual: Some(Visual {
            answers: genui.visual_answers(),
            places: genui.places(),
            location: genui.user_location(),
        }),
        peers: Some(control),
        transfers: Some(transfer.agent_transfers()),
        reactions: Some(Arc::new(cx.sessions.clone())),
        capabilities: Some(cx.capabilities.clone()),
        routines: Some(routines.tools()),
        architect: Some(routines.architect()),
        surfaces: Some(surfaces.tools()),
    })))
}
