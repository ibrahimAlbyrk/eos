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
mod capabilities;
mod display;
mod files;
mod host;
mod machines;
mod maintenance;
mod memory;
mod modules;
mod notes;
mod patches;
mod peer;
mod plugins;
mod reach;
mod scripts;
mod terminals;
mod threads;
mod tools;
mod updates;
mod wakes;

pub use agent::AgentOptions;
pub use app::{App, Options, Shell};
pub use callers::Callers;
pub use capabilities::CapabilityOptions;
pub use threads::{MAX_BLOCKING_THREADS, MAX_WORKERS, MIN_WORKERS, runtime, workers};
pub use wakes::WakeCounter;

/// How the installed app reaches the phone link's relay: a WebSocket it
/// dials out, redialled when it drops and at once after the computer wakes.
/// Hand it to [`Options::relay`]; an app built without it, or one that does
/// not [reach the network](Options::reaches_network), never dials.
pub fn relay() -> std::sync::Arc<dyn eos_core::net::relay::Relay> {
    std::sync::Arc::new(eos_relay::RelayClient::new(std::sync::Arc::new(eos_core::SystemClock)))
}

/// How the installed app reaches the relay's hook inbox, for the webhooks of
/// outside services. Hand it to [`Options::hook_client`]; an app built
/// without it, or one that does not [reach the network](Options::reaches_network),
/// has no inbox and adds no webhook.
pub fn hook_client() -> eos_relay::HookClient {
    eos_relay::HookClient::new()
}

/// Where the installed app keeps capability secrets: its own Keychain items.
/// Hand it to [`Options::keychain`]; an app built without it, or one that
/// does not [reach the network](Options::reaches_network), keeps none.
pub fn keychain() -> std::sync::Arc<dyn eos_core::capability::CapabilitySecrets> {
    std::sync::Arc::new(eos_auth::AppKeychainSecrets::host())
}

/// How the installed app reaches GitHub: an HTTP client of its own. Hand it
/// to [`Options::github`]; an app built without it, or one that does not
/// [reach the network](Options::reaches_network), sends GitHub nothing.
pub fn github() -> Result<std::sync::Arc<dyn eos_github::Transport>, Error> {
    Ok(std::sync::Arc::new(eos_github::HttpTransport::new()?))
}

/// The installed app's GitHub CLI: the `gh` on this computer, or the one it
/// installs under `tools` (`<data folder>/tools`). Hand it to
/// [`Options::github_cli`]; an app built without it, or one that does not
/// [reach the network](Options::reaches_network), never runs `gh`.
pub fn github_cli(tools: std::path::PathBuf) -> Result<std::sync::Arc<dyn eos_github::Cli>, Error> {
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    Ok(std::sync::Arc::new(eos_github::Gh::new(eos_kit_proc::Runner::new(trees), tools)?))
}

/// How the installed app reaches Slack: an HTTP client of its own. Hand it
/// to [`Options::slack`]; an app built without it, or one that does not
/// [reach the network](Options::reaches_network), sends Slack nothing.
pub fn slack() -> Result<std::sync::Arc<dyn eos_slack::Transport>, Error> {
    Ok(std::sync::Arc::new(eos_slack::HttpTransport::new()?))
}

/// How the installed app drives the Mail app: `osascript`. Hand it to
/// [`Options::mail`]; an app built without it, or one that does not
/// [reach the network](Options::reaches_network), never runs it.
pub fn mail() -> std::sync::Arc<dyn eos_mail_app::Script> {
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    std::sync::Arc::new(eos_mail_app::Osascript::new(eos_kit_proc::Runner::new(trees)))
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
    /// The client the GitHub capability talks through could not be set up.
    #[error("github: {0}")]
    GitHub(#[from] eos_github::Error),
    #[error("slack: {0}")]
    Slack(#[from] eos_slack::Error),
    /// This computer's identity for its paired computers cannot be read.
    #[error("peering: {0}")]
    Peer(#[from] eos_peer::Error),
    /// Two modules clash, or a route has no access rule.
    #[error(transparent)]
    Runtime(#[from] eos_runtime::Error),
}
