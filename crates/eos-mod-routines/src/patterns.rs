//! The patterns that recognise each kind of item, as the capabilities there
//! are offer them. Every routine row carries its kind's patterns, also one
//! built inside a write job, where the capabilities cannot be read: so the
//! patterns are kept here, read again before each list or detail of
//! routines and once at start.

use std::sync::{Arc, Mutex};

use eos_core::capability::{CapabilityReads, ItemRecogniser};

use crate::engine::Engine;
use crate::intent::item_patterns;

pub(crate) struct ItemPatterns {
    reads: Arc<dyn CapabilityReads>,
    known: Mutex<Vec<ItemRecogniser>>,
}

impl ItemPatterns {
    pub(crate) fn new(reads: Arc<dyn CapabilityReads>) -> Self {
        Self { reads, known: Mutex::new(Vec::new()) }
    }

    /// Reads the recognisers again; on a failure the last ones stay.
    pub(crate) async fn refresh(&self) {
        match self.reads.recognisers().await {
            Ok(recognisers) => *Engine::locked(&self.known) = recognisers,
            Err(error) => tracing::warn!(%error, "the item recognisers could not be read"),
        }
    }

    /// The patterns of an item of `kind`.
    pub(crate) fn of(&self, kind: &str) -> Vec<String> {
        item_patterns(&Engine::locked(&self.known), kind)
    }
}
