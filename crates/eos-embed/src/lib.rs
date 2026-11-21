//! Memory's meaning vectors on this Mac: the `Embedder` port over a static
//! model2vec model (the official potion-multilingual-128M, f32) read from a
//! folder the host hands in. The installed app's folder is inside its bundle
//! (`Contents/Resources/models/potion-multilingual-128M`); a dev run names
//! one with `EOS_EMBED_MODEL_DIR`. A test uses a fake, and the real model only
//! where that variable names its folder. Nothing is downloaded and no text
//! leaves the process.
//!
//! Loading reads about 530 MB and takes about a second in a release build:
//! call [`LocalEmbedder::load`] on a blocking thread. model2vec copies the
//! table into memory (it maps only a `'static` slice, and mapping a file
//! needs `unsafe`), so the loaded model holds about 670 MB of heap: 512 MB of
//! table and the rest its search over the 500,000-piece vocabulary. The
//! `model2vec-rs` it uses is patched (`vendor/`, `patches/0001`) so the
//! vocabulary is held once, not a second time inside the `tokenizers` crate's
//! model. Embedding a text takes well under a millisecond.

use std::fmt;
use std::path::{Path, PathBuf};

use eos_core::experience::Embedder;
use eos_core::{BoxFuture, Error as PortError};
use model2vec_rs::model::StaticModel;

/// The files a model folder holds.
pub const MODEL_FILES: [&str; 3] = ["tokenizer.json", "model.safetensors", "config.json"];

/// The variable that names a model folder outside the bundle.
pub const MODEL_DIR_VAR: &str = "EOS_EMBED_MODEL_DIR";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the model folder has no {0}")]
    Missing(PathBuf),
    #[error("reading {path}: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("the model does not load: {0}")]
    Invalid(String),
}

/// A model loaded from its folder.
pub struct LocalEmbedder {
    model: StaticModel,
    name: String,
    dims: usize,
}

impl fmt::Debug for LocalEmbedder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LocalEmbedder").field("name", &self.name).field("dims", &self.dims).finish()
    }
}

impl LocalEmbedder {
    /// Loads the model in `dir`; its name is the folder's name, so vectors of
    /// another model are never compared with its own.
    pub fn load(dir: &Path) -> Result<Self, Error> {
        let mut bytes = Vec::with_capacity(MODEL_FILES.len());
        for file in MODEL_FILES {
            let path = dir.join(file);
            if !path.is_file() {
                return Err(Error::Missing(path));
            }
            bytes.push(std::fs::read(&path).map_err(|source| Error::Read { path, source })?);
        }
        let model = StaticModel::from_bytes(&bytes[0], &bytes[1], &bytes[2], Some(true))
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let name = dir.file_name().map_or_else(|| "model".to_owned(), |n| n.to_string_lossy().into_owned());
        let dims = model.dim();
        Ok(Self { model, name, dims })
    }
}

impl Embedder for LocalEmbedder {
    fn model(&self) -> &str {
        &self.name
    }

    fn dims(&self) -> usize {
        self.dims
    }

    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, PortError>> {
        Box::pin(async move { Ok(self.model.encode(texts)) })
    }
}

#[cfg(test)]
mod tests;
