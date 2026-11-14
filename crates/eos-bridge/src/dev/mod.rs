//! A development or test run (`dev-run`): the app on a copy of real data. The Rust core
//! answers every request, except those that could start an agent, a model call or a
//! command, reach another computer or change the user's own folders (see [`guard`]).

pub mod guard;
mod guarded;

pub use guarded::Guarded;
