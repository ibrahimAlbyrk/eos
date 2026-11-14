//! One Claude sign-in's claude.ai Artifacts.

use eos_contracts::ArtifactSummary;

use crate::BoxFuture;

pub trait ArtifactSource: Send + Sync + 'static {
    /// The sign-in's live artifacts. `Err`: why not, in words short enough to
    /// show the user (signed out, an upstream failure); never the token. A
    /// read the caller drops is abandoned.
    fn list<'a>(&'a self, login_id: &'a str) -> BoxFuture<'a, Result<Vec<ArtifactSummary>, String>>;
}
