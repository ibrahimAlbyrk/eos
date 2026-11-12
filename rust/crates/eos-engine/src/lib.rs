//! Agent sessions on `eos-agent-sdk`: the one adapter of
//! [`eos_core::agent::AgentRuntime`], and the only crate that runs agents.
//!
//! [`Engine::build`] makes what every session shares once (the engine's HTTP
//! client, tools, prompts, MCP hub and transcript store). [`Engine::start`]
//! turns a [`LaunchSpec`](eos_core::agent::LaunchSpec) into an engine agent
//! with Eos's tools, credential and system prompt, and starts the session's
//! pump, which maps what the engine reports to canonical events
//! ([`mapper`]) for the session's sink.
//!
//! What the engine asks back, as traits of `eos-core`: every tool call is
//! decided by [`PolicyDecider`](eos_core::policy::PolicyDecider); Eos's tools
//! come from [`ToolSets`](eos_core::agent::ToolSets); credentials and what to
//! do when one stops working from
//! [`SessionCredentials`](eos_core::accounts::SessionCredentials); a focused
//! session's questions go to [`UserQuestions`](eos_core::agent::UserQuestions).

mod accounts;
mod commands;
mod engine;
mod gate;
mod mapper;
mod prompter;
mod registry;
mod session;
mod tools;
mod transcript;
mod workflow_files;

pub use engine::{Engine, EngineDeps, EngineOptions, LazyEngine};
pub use workflow_files::WorkflowFiles;

/// The engine's scripted stand-in for the model API (tests only).
#[cfg(feature = "mock-api")]
pub mod mock_api {
    pub use eos_agent_mock_api::{MockApi, Recorded, Reply};
}
