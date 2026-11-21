//! An embedder that loads no model: each word adds to the dimensions its hash
//! names, so texts that share words point the same way and a test can rely on
//! meaning search without any model file. And the real model, for the few
//! tests that measure it, only where `EOS_EMBED_MODEL_DIR` names its folder.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use eos_core::experience::Embedder;
use eos_core::{BoxFuture, Error};
use eos_embed::{LocalEmbedder, MODEL_DIR_VAR};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub struct FakeEmbedder {
    model: &'static str,
    dims: usize,
    /// Every batch it was asked to embed, in order.
    pub batches: Mutex<Vec<Vec<String>>>,
    /// Fails every call while set.
    pub failing: AtomicBool,
}

impl FakeEmbedder {
    pub const MODEL: &'static str = "fake-words-64";

    pub fn new() -> Self {
        Self::named(Self::MODEL)
    }

    /// The same embedder under another model name, as a model that changed.
    pub fn named(model: &'static str) -> Self {
        Self { model, dims: 64, batches: Mutex::new(Vec::new()), failing: AtomicBool::new(false) }
    }

    fn vector(&self, text: &str) -> Vec<f32> {
        let mut v = vec![0f32; self.dims];
        for word in text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 1) {
            let digest = Sha256::digest(word.as_bytes());
            let at = usize::from(digest[0]) % self.dims;
            v[at] += if digest[1] & 1 == 0 { 1.0 } else { -1.0 };
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        v
    }
}

impl Default for FakeEmbedder {
    fn default() -> Self {
        Self::new()
    }
}

impl Embedder for FakeEmbedder {
    fn model(&self) -> &str {
        self.model
    }

    fn dims(&self) -> usize {
        self.dims
    }

    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, Error>> {
        Box::pin(async move {
            self.batches.lock().expect("batches").push(texts.to_vec());
            if self.failing.load(Ordering::SeqCst) {
                return Err(Error::Storage("the fake embedder fails".into()));
            }
            Ok(texts.iter().map(|t| self.vector(t)).collect())
        })
    }
}

/// The shipped model from the folder `EOS_EMBED_MODEL_DIR` names; `None`
/// without it, so a test that wants it skips. Never downloaded.
pub fn real_embedder() -> Option<Arc<LocalEmbedder>> {
    let dir = std::env::var_os(MODEL_DIR_VAR)?;
    Some(Arc::new(LocalEmbedder::load(std::path::Path::new(&dir)).expect("the model folder loads")))
}
