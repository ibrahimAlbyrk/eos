//! A spike against the agent engine pinned in the root `Cargo.toml`
//! (`eos-agent-sdk` at `75dd110`). It answers two questions for routine runs,
//! with the engine's mock API as the model:
//!
//! 1. Does a focused session run a Workflow call with `scriptPath` and
//!    `args`, and from which folders does `scriptPath` load?
//!    (`tests/workflow_script_path.rs`)
//! 2. Which parts of a folder's project configuration does a session load,
//!    and which `AgentOptions` switch turns each off? (`tests/project_config.rs`)
//!
//! Run with `-- --nocapture` to see what each case sent to the model.

pub mod bench;
pub mod gate;
pub mod requests;
