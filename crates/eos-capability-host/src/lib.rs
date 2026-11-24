//! The host of capability packages that are code (06 §4.1): it runs the
//! actions of `script` packages (and, later, `mcp` ones) as the
//! [`ActionRunner`] the capability service calls, each under the OS sandbox
//! ([`Confinement`]) with exactly the reach its manifest declares. Nothing
//! runs unconfined: without the sandbox an action is refused as
//! `sandbox_unavailable`.
//!
//! A script action is its `run` program, started in its package folder with
//! the call's input as JSON on stdin and its answer as JSON on stdout. It
//! sees only the environment the manifest gives it (its secrets in their
//! variables, `PATH` and `HOME`), may write only its `data/` folder and the
//! call's own temp folder, and is ended at its deadline. What the sandbox
//! denied is logged by kind and count; inputs, outputs, secrets and paths
//! the code reached are not.
//!
//! [`ActionRunner`]: eos_core::capability::ActionRunner
//! [`Confinement`]: eos_core::capability::Confinement

mod script;

pub use script::{OUTPUT_MAX_BYTES, SANDBOX_UNAVAILABLE, ScriptHost};
