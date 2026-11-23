//! Routine surfaces: the interfaces a run answers with outside a chat (a View
//! now; Pages and Apps later). This crate holds their pure rules: the type
//! language data, action arguments and query arguments are written in, the
//! check of data against a contract, and the least data a contract accepts.
//! Nothing here is async, reads a clock or touches a file; the feature
//! `eos-mod-surfaces` stores and serves what these rules decide.

mod minimal;
mod problem;
mod types;
mod validate;

pub use minimal::minimal_data;
pub use problem::{Problem, format_problems};
pub use types::{Contract, Field, MAX_DEPTH, Type};
pub use validate::{Validation, validate};
