//! Ports of memory: what turns a note's text into its meaning. Note text is
//! the user's data: an implementation never logs it and never sends it off
//! the Mac.

use crate::{BoxFuture, Error};

/// Turns texts into meaning vectors, the same text always into the same
/// vector. Vectors from different models never mix: each stored vector
/// records [`model`](Embedder::model).
pub trait Embedder: Send + Sync {
    /// The model's name, stored with each vector.
    fn model(&self) -> &str;
    /// The length of every vector.
    fn dims(&self) -> usize;
    /// One vector per text, in order.
    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, Error>>;
}
