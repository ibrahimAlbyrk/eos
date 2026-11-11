//! Development only: an isolated Node daemon stands in for the core while the Rust core
//! grows route by route. `/_core/*` and the raw origin are forwarded to it, the daemon's
//! browser verbs are served from the shell's views, and its notifications reach the banner.
//!
//! The daemon behind this must never run an agent: every write is refused here except the
//! few the dashboard needs to show itself (see [`guard`]).

mod axtree;
mod driver;
pub mod guard;
mod host_channel;
mod hybrid;
mod proxy;
mod stream;

pub use driver::Driver;
pub use host_channel::{HostChannel, spawn_host_channel};
pub use hybrid::{Hybrid, STREAM_ROUTES};
pub use proxy::{DevDaemon, DevDaemonConfig};
pub use stream::spawn_notifications;
