//! Memory's composition: where its meaning model comes from.
//!
//! The model ships in the app bundle
//! (`Contents/Resources/models/potion-multilingual-128M`); a development run
//! names a folder with `EOS_EMBED_MODEL_DIR`. A run with neither (every test)
//! has no model and recalls by hooks and words. Nothing is ever downloaded.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_core::agent::WorkerSessions;
use eos_core::experience::Embedder;
use eos_core::profile::UserProfileReader;
use eos_core::routine::RunLookup;
use eos_domain::config::Env;

use crate::modules::Context;

/// The model's folder inside the bundle's resources.
const BUNDLED_MODEL: &str = "models/potion-multilingual-128M";
const MODEL_DIR_VAR: &str = "EOS_EMBED_MODEL_DIR";

/// The meaning model's folder: the one `EOS_EMBED_MODEL_DIR` names, else the
/// bundle's, when it is there.
pub(crate) fn model_dir(resources: Option<&Path>, env: &Env) -> Option<PathBuf> {
    if let Some(dir) = env.get(MODEL_DIR_VAR).filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    resources.map(|r| r.join(BUNDLED_MODEL)).filter(|dir| dir.is_dir())
}

/// Reminders go to a worker's live session, with its next request.
struct SessionNotes(eos_sessions::Sessions);

impl eos_mod_memory::NoteSink for SessionNotes {
    fn note(&self, worker_id: &str, text: String) -> bool {
        let Some(session) = WorkerSessions::session(&self.0, worker_id) else { return false };
        session.note(text).is_ok()
    }
}

pub(crate) fn module(
    cx: &Context,
    runs: Arc<dyn RunLookup>,
    profile: Arc<dyn UserProfileReader>,
) -> Arc<eos_mod_memory::MemoryModule> {
    let embedder = cx.embed_model.clone().map(|dir| -> eos_mod_memory::LoadEmbedder {
        Box::new(move || {
            eos_embed::LocalEmbedder::load(&dir).map(|e| Arc::new(e) as Arc<dyn Embedder>).map_err(|e| e.to_string())
        })
    });
    Arc::new(eos_mod_memory::MemoryModule::new(eos_mod_memory::MemoryParts {
        store: cx.store.clone(),
        clock: cx.clock.clone(),
        sleeper: cx.sleeper.clone(),
        ids: cx.ids.clone(),
        runs: Some(runs),
        sink: Arc::new(SessionNotes(cx.sessions.clone())),
        project_keys: cx.project_keys.clone(),
        profile,
        embedder,
        code: Some(eos_mod_memory::CodeParts { bus: cx.bus.clone(), transcripts: cx.terminals.transcripts.clone() }),
        background_model_calls: cx.reach.background_model_calls(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_variable_wins_and_a_bundle_without_the_model_has_none() {
        let tmp = std::env::temp_dir().join(format!("eos-embed-dir-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join(BUNDLED_MODEL)).expect("a model folder");
        let none = Env::default();
        assert_eq!(model_dir(None, &none), None);
        assert_eq!(model_dir(Some(&tmp), &none), Some(tmp.join(BUNDLED_MODEL)));
        assert_eq!(model_dir(Some(&tmp.join("elsewhere")), &none), None);
        let named = Env::new([(MODEL_DIR_VAR.to_owned(), "/models/potion".to_owned())]);
        assert_eq!(model_dir(Some(&tmp), &named), Some(PathBuf::from("/models/potion")));
        std::fs::remove_dir_all(&tmp).expect("removed");
    }
}
