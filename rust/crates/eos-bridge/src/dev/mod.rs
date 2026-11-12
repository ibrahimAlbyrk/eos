//! Development only: an isolated Node daemon stands in for the core while the Rust core
//! grows route by route. `/_core/*` and the raw origin are forwarded to it where the Rust
//! router declares no route, and its notifications reach the banner.
//!
//! Neither side may make an agent run on the copy of real data they share: the daemon gets
//! no write but the few the dashboard needs to show itself, the Rust router none that could
//! start one (see [`guard`]).

pub mod guard;
mod hybrid;
mod proxy;
mod stream;

pub use hybrid::Hybrid;
pub use proxy::{DevDaemon, DevDaemonConfig};
pub use stream::spawn_notifications;
