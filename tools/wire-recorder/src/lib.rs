//! Checks the Rust core against what the Node daemon answered, route by route.
//!
//! A recording holds one route group's steps (requests and stream openings)
//! and the daemon's normalized answers, frozen when the daemon still existed.
//! `replay` runs the steps against a [`target::Target`] (the Rust core in
//! process), normalizes the same way and reports every difference.

pub mod clock;
pub mod coverage;
pub mod diff;
pub mod inproc;
pub mod known;
pub mod model;
pub mod normalize;
pub mod renumber;
pub mod runner;
pub mod sse;
pub mod target;
pub mod vars;
