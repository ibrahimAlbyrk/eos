//! Worker definitions: the "available workers" a spawn starts from.
//!
//! A definition is a markdown file with frontmatter (or the same data posted
//! by an orchestrator at runtime). Sources, lowest precedence first: built-in,
//! the user's folder, the project's folder, runtime. A definition of the same
//! name in a later source replaces an earlier one entirely; `extends` is the
//! only way fields are shared.
//!
//! - [`definition`]: a file's frontmatter and body → a validated record.
//! - [`resolve`]: the definition a spawn names, `extends`, the defaults it
//!   pre-fills, `provider/model`, the tool scope it bakes.
//! - [`catalog`]: the list an orchestrator sees, and its prompt text.
//! - [`WorkerDefinitions`]: the service over the files and `state.db`.

pub mod catalog;
pub mod definition;
pub mod resolve;
mod service;

pub use service::WorkerDefinitions;
