//! Freezes what a daemon answers so another implementation can be checked
//! against it route by route.
//!
//! A scenario file lists requests (and stream openings) for one route group.
//! `record` walks it against a [`target::Target`], normalizes what came back
//! and writes a recording. `replay` runs a recording's steps against another
//! target, normalizes the same way and reports every difference.

pub mod clock;
pub mod coverage;
pub mod diff;
pub mod http;
pub mod model;
pub mod normalize;
pub mod runner;
pub mod sse;
pub mod target;
pub mod vars;
