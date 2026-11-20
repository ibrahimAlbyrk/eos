//! Ports of memory: what turns a note's text into its meaning, and how an
//! agent searches what was learned. Note text is
//! the user's data: an implementation never logs it and never sends it off
//! the Mac.

use eos_domain::experience::{NoteState, Scope, Trust};

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

/// A note as an agent's own search finds it.
#[derive(Debug, Clone, PartialEq)]
pub struct FoundNote {
    pub id: String,
    pub text: String,
    pub scope: Scope,
    pub state: NoteState,
    pub trust: Trust,
}

/// `recall_experience` for one agent: notes that match `query` where it
/// works, best first, at most `limit`. [`Error::PermissionDenied`] when the
/// user withholds their profile from the agent's backend kind.
pub trait ExperienceSearch: Send + Sync {
    fn search<'a>(
        &'a self,
        agent_id: &'a str,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<FoundNote>, Error>>;
}
