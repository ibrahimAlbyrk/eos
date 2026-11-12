//! Terminals.
//!
//! - [`PtyTerminals`]: the user's login shell in a PTY ([`eos_core::terminal::Terminals`]).
//! - [`Screen`]: the screen mirror — a headless terminal whose
//!   [`snapshot`](Screen::snapshot) redraws it in a client.
//! - [`ShellRunner`]: one-shot command lines in the user's shell.
//! - [`ClaudeLocator`]: where the user's own Claude Code is.
//! - [`ClaudeTranscriptFiles`]: Claude Code's transcripts, read as they grow.

mod commands;
mod host;
mod screen;
mod transcripts;
mod utf8;

pub use commands::{ClaudeLocator, ShellRunner};
pub use host::{PtyTerminals, terminal_env};
pub use screen::Screen;
pub use transcripts::{ClaudeTranscriptFiles, TranscriptReader};
