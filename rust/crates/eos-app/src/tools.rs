//! Eos's own tools for agents: the registry over the features it calls.

use std::sync::Arc;

use eos_accounts::TokioSleeper;
use eos_mod_agents::{AgentsModule, ToolControl};
use eos_mod_genui::GenuiModule;
use eos_mod_pages::PagesModule;
use eos_mod_profile::ProfileModule;
use eos_tools::{Services, Tools, Visual};

use crate::host::HostTimeZone;
use crate::modules::Context;

/// The registry. The browser, peers and transfers join when their features
/// are in the app: until then no session has their tools.
pub(crate) fn build(
    cx: &Context,
    agents: &AgentsModule,
    genui: &GenuiModule,
    pages: &PagesModule,
    profile: &ProfileModule,
) -> Result<Arc<Tools>, eos_runtime::Error> {
    let questions = Arc::new(cx.questions.clone());
    Ok(Arc::new(Tools::new(Services {
        prompts: cx.prompts.registry().clone(),
        clock: cx.clock.clone(),
        sleeper: Arc::new(TokioSleeper),
        zone: Arc::new(HostTimeZone),
        store: cx.store.clone(),
        models: cx.models.clone(),
        definitions: cx.worker_definitions.clone(),
        workers: Arc::new(ToolControl::new(agents, Arc::new(crate::files::git(&cx.clock)))?),
        notifier: questions.clone(),
        questions,
        pages: pages.editor(),
        memory_search: profile.memory_search(),
        memory_suggestions: profile.memory_suggestions(),
        plugins: cx.plugins.clone(),
        browser: None,
        visual: Some(Visual {
            answers: genui.visual_answers(),
            places: genui.places(),
            location: genui.user_location(),
        }),
        peers: None,
        transfers: None,
    })))
}
