//! Outbound HTTP.
//!
//! - [`http_client`]: the `reqwest` client every adapter starts from (rustls,
//!   pooled connections, no proxy). Build one per kind of traffic at
//!   composition and clone it: clones share the pool.
//! - [`SafeFetcher`]: a GET for URLs an agent wrote. The app runs on the
//!   user's computer, so the guard is what keeps such a URL from reaching the
//!   local network, loopback services or cloud metadata.
//! - [`is_blocked_address`]: which addresses that guard refuses.

mod client;
mod error;
mod guard;
mod safe_fetch;

pub use client::{ClientOptions, http_client};
pub use error::Error;
pub use guard::{is_blocked_address, is_blocked_ip};
pub use safe_fetch::{Resolver, SafeFetcher, SafeGetOptions, SafeResponse, SystemResolver, check_url};
