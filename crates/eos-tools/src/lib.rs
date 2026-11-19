//! The tools Eos gives its agents.
//!
//! Each tool is a native host tool over the service it calls: no server, no
//! request to ourselves. What the model sees of a tool — its name
//! (`read_page`), the description rendered from the prompt library, the
//! input schema, and the result and error texts — is held to the vectors in
//! `fixtures/tools`.
//!
//! [`Tools`] is the whole registry and answers which tools a session gets
//! ([`eos_core::agent::ToolSets`]):
//!
//! | Session | Tools |
//! |---|---|
//! | orchestrator | control, pages, memory, browser, capabilities, visual answers, plugins, reactions |
//! | worker (and its sub-workers, the git worker) | report, date, pages, memory, browser, capabilities, plugins |
//! | … started to collaborate | + the peer tools |
//! | … focused (the chat the user talks to) | + `send_to_machine`, visual answers, reactions |
//!
//! A tool of a built-in plugin that is switched off is left out of sessions
//! started meanwhile; so are the capability tools while the Eos preview
//! (`eos.preview` in `settings.json`) is off. A feature that has not been handed over
//! ([`Services`]' optional parts) leaves its tools out of every session.
//! Under tool search (focused sessions) every tool but `present`, `react`
//! and `no_reply` waits behind the search. No subagent is offered an Eos tool: the permission
//! gate refuses each such call anyway.

mod browser;
mod capabilities;
mod control;
mod js;
mod memory;
mod messages;
mod pages;
mod peers;
mod plugins;
mod reactions;
mod registry;
mod schema;
#[cfg(test)]
mod tests;
mod time;
mod tool;
mod transfer;
mod user;
mod visual;

pub use registry::{Services, Tools};
pub use visual::Visual;
