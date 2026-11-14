//! Where sign-ins and keys live, and how a user signs in.
//!
//! - [`FilePlanLoginStore`], [`AccountDirs`]: `accounts/logins.json` and the
//!   store folders beside it.
//! - [`Stores`]: the credential stores. A Claude store is the item the claude
//!   binary keeps for that folder (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), read
//!   and renewed by the agent engine's own `ClaudeLogin`, under the store's
//!   refresh lock: stores the TypeScript app signed in keep working, and a
//!   token read for a usage or artifact call renews exactly as an agent's
//!   request does.
//! - [`ClaudeSignIn`], [`ChatGptSignIn`]: the providers' browser sign-ins.
//! - [`ClaudeUsageApi`], [`FileUsageSnapshots`], [`ClaudeTokenProbe`]: plan
//!   usage and the check of an old setup-token.
//! - [`FrameApiArtifacts`]: each Claude sign-in's claude.ai Artifacts.
//! - [`ClaudeModels`]: the models Claude lists for the user's sign-in.
//! - [`PlatformSecrets`]: provider API keys in the system's secret store.
//!
//! This crate uses the engine's provider sign-in crates
//! (`eos-agent-anthropic`, `eos-agent-openai`) and nothing else of it.

mod artifacts;
mod models;
mod registry;
mod secrets;
mod sign_in;
mod stores;
mod usage;

pub use artifacts::{FrameApiArtifacts, NO_TOKEN_MESSAGE, REJECTED_MESSAGE, artifact_summary};
pub use models::ClaudeModels;
pub use registry::{AccountDirs, FilePlanLoginStore};
pub use secrets::{HostCredentials, PlatformSecrets};
pub use sign_in::{ChatGptSignIn, ClaudeSignIn};
pub use stores::{Endpoints, Stores};
pub use usage::{ClaudeTokenProbe, ClaudeUsageApi, FileUsageSnapshots};
