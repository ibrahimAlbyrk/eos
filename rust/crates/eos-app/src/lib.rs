//! The composition root: the only crate that knows every concrete type.
//!
//! ```text
//! let app = App::build(Options::new(home))?;   // data folder → adapters → modules → router
//! app.start().await?;                          // modules start, then get ready
//! let res = app.router().handle(request).await; // the bridge and the gateways call this
//! app.shutdown(Duration::from_secs(5)).await;  // modules stop, streams end, the writer drains
//! ```
//!
//! A feature is one line in [`modules`]. Whoever hands a request to the
//! router tags it with its caller first: [`Callers`] turns the ui-token a
//! local request carries into that tag.

mod agent;
mod announce;
mod app;
mod boot;
mod callers;
mod display;
mod files;
mod host;
mod machines;
mod modules;
mod notes;
mod patches;
mod peer;
mod plugins;
mod terminals;
mod threads;
mod tools;
mod updates;

pub use agent::AgentOptions;
pub use app::{App, Options, Shell};
pub use callers::Callers;
pub use threads::{MAX_BLOCKING_THREADS, MAX_WORKERS, MIN_WORKERS, runtime, workers};

/// How the installed app reaches the phone link's relay: a WebSocket it
/// dials out, redialled when it drops and at once after the computer wakes.
/// Hand it to [`Options::relay`]; an app built without it never dials.
pub fn relay() -> std::sync::Arc<dyn eos_core::net::relay::Relay> {
    std::sync::Arc::new(eos_relay::RelayClient::new(std::sync::Arc::new(eos_core::SystemClock)))
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The data folder cannot be used (created, read, written).
    #[error("data folder {}: {source}", path.display())]
    Home { path: std::path::PathBuf, source: std::io::Error },
    /// `state.db` did not open or migrate.
    #[error("database: {0}")]
    Database(#[from] eos_kit_sqlite::Error),
    /// A start-up step over the stored data failed.
    #[error("start-up: {0}")]
    Data(#[from] eos_core::Error),
    /// The clients that fetch for visual answers could not be set up.
    #[error("media: {0}")]
    Media(#[from] eos_genui_media::Error),
    /// This computer's identity for its paired computers cannot be read.
    #[error("peering: {0}")]
    Peer(#[from] eos_peer::Error),
    /// Two modules clash, or a route has no access rule.
    #[error(transparent)]
    Runtime(#[from] eos_runtime::Error),
}
