//! The shell's half that has no window: the transport between a page request and the core's
//! router, the URL space of the app's own origin, the shell bridges and the dashboard bundle.
//!
//! `eos-shell` owns Tauri and CEF and hands every request of `http://eos.localhost` and
//! `http://raw.eos.localhost` to [`Bridge`]; nothing here has a Tauri or CEF type.

#![cfg_attr(test, allow(clippy::unwrap_used))]

pub mod assets;
mod bridge;
pub mod chromium;
pub mod core;
#[cfg(feature = "dev-proxy")]
pub mod dev;
pub mod events;
pub mod host;
pub mod instance;
pub mod lan_guard;
pub mod migrate;
pub mod panel;
pub mod power;
pub mod range;
pub mod router;
pub mod script;
#[cfg(test)]
mod testdir;
pub mod token;
pub mod transport;
pub mod urlspace;
pub mod window_state;

pub use bridge::{Bridge, Notified, Parts, sanitize_filename};
pub use core::{Core, NoCore, Plane};
pub use host::{Banner, BannerTarget, EditCommand, ShellHost, Theme};
pub use router::{Classify, RouterCore};
pub use transport::{Body, Head, Initiator, Read, Req, Service, Sink, channel};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The old profile's storage could not be read or the marker not written.
    #[error("storage carry-over: {0}")]
    Migration(String),
    /// The dev proxy could not reach its daemon.
    #[error("dev proxy: {0}")]
    DevProxy(String),
}
