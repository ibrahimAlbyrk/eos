//! What a feature sees of the running app: requests and responses as values,
//! the router and its access rules, the event bus and the resumable stream
//! over it, the ordered lane, the job registry, idle hooks, the module trait
//! and the lifecycle. See the crate's README for the model in one page.

pub mod access;
pub mod bus;
pub mod error;
pub mod http;
pub mod idle;
pub mod jobs;
pub mod lifecycle;
pub mod live_text;
pub mod module;
pub mod ordered;
pub mod patches;
pub mod router;
pub mod runtime;
pub mod stream;

pub use error::{Conflict, Error};
pub use runtime::{Kernel, KernelOptions, Runtime};
