//! Running other programs.
//!
//! Every child leads its own process tree, has a deadline and bounded output,
//! and gets exactly the environment its [`Env`] describes. When the deadline
//! passes, or the caller stops listening (drops the future or the [`Child`]),
//! the whole tree is ended and the child is reaped: no orphans, no zombies.
//!
//! - [`Runner::run`]: to completion, output collected up to a cap.
//! - [`Runner::spawn`]: output as it arrives, through a bounded queue; with
//!   [`Command::stdin_open`], a conversation over the child's stdin.
//!
//! How a process tree is made and ended differs per system, so those two
//! operations arrive as values ([`ProcessTrees`]) from the platform seam:
//!
//! ```text
//! let runner = Runner::new(ProcessTrees::new(eos_platform::isolate_command, |pid| {
//!     eos_platform::kill_process_tree(pid).is_ok()
//! }));
//! ```
//!
//! Needs a tokio runtime with its time driver.

mod command;
mod env;
mod error;
mod runner;

pub use command::{Command, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT, Overflow};
pub use env::Env;
pub use error::Error;
pub use runner::{Child, Event, Exit, Output, ProcessTrees, Runner, Stdin};
