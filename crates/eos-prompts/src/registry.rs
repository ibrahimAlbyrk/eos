//! The parsed library.

use std::sync::{Arc, RwLock};

use eos_core::Error;
use eos_core::prompt::{PromptSource, SourceStamp};

use crate::prompt::{Fragment, ParsedPrompt, parse_prompt, to_fragment};

/// The prompts of a [`PromptSource`], parsed. [`reload`](Self::reload) reads
/// the source again (once per assembled prompt, so an edit applies to the
/// next spawn) unless its stamp says nothing changed since the last read. A
/// prompt that does not parse is left out with a warning: one broken file
/// never stops a session from starting.
pub struct PromptRegistry {
    source: Arc<dyn PromptSource>,
    /// In the source's order; a later prompt of the same id took the earlier
    /// one's place. With the source's stamp from before it was read.
    cache: RwLock<Option<Read>>,
}

/// The parsed prompts and the source's stamp from before they were read.
type Read = (Option<SourceStamp>, Arc<Vec<ParsedPrompt>>);

impl std::fmt::Debug for PromptRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromptRegistry").finish_non_exhaustive()
    }
}

impl PromptRegistry {
    pub fn new(source: Arc<dyn PromptSource>) -> Self {
        Self { source, cache: RwLock::new(None) }
    }

    fn read(&self) -> Arc<Vec<ParsedPrompt>> {
        let mut prompts: Vec<ParsedPrompt> = Vec::new();
        for raw in self.source.list() {
            match parse_prompt(&raw) {
                Ok(parsed) => match prompts.iter_mut().find(|p| p.id == parsed.id) {
                    Some(slot) => *slot = parsed,
                    None => prompts.push(parsed),
                },
                Err(e) => tracing::warn!(error = %e, "prompt skipped: {}", raw.id),
            }
        }
        Arc::new(prompts)
    }

    pub fn reload(&self) {
        // Taken before the read: a change made during it shows in the next stamp.
        let stamp = self.source.stamp();
        if stamp.is_some() {
            let cache = self.cache.read().unwrap_or_else(|poisoned| poisoned.into_inner());
            if cache.as_ref().is_some_and(|(seen, _)| *seen == stamp) {
                return;
            }
        }
        let fresh = self.read();
        *self.cache.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((stamp, fresh));
    }

    /// Every prompt, in the library's order.
    pub fn list(&self) -> Arc<Vec<ParsedPrompt>> {
        if let Some((_, cached)) = self.cache.read().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
            return cached.clone();
        }
        self.reload();
        let cache = self.cache.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.as_ref().map(|(_, prompts)| prompts.clone()).unwrap_or_default()
    }

    pub fn has(&self, id: &str) -> bool {
        self.list().iter().any(|p| p.id == id)
    }

    pub fn get(&self, id: &str) -> Result<ParsedPrompt, Error> {
        self.list().iter().find(|p| p.id == id).cloned().ok_or_else(|| Error::not_found("prompt", id))
    }

    /// The prompts that take part in system prompts.
    pub fn fragments(&self) -> Vec<Fragment> {
        self.list().iter().cloned().filter_map(to_fragment).collect()
    }
}
