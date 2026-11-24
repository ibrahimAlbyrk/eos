//! Routine surfaces: the interfaces a run answers with outside a chat (a View
//! now; Pages and Apps later). This crate holds their pure rules: the type
//! language data, action arguments and query arguments are written in, the
//! check of data against a contract, the least data a contract accepts, and
//! how versions, issues and pins move and age, and what a View outside a
//! chat must bind, and what a Page's template may be made of.
//! Nothing here is async, reads a clock or touches a file; the feature
//! `eos-mod-surfaces` stores and serves what these rules decide.

pub mod limits;
pub mod template;

mod args;
mod lifecycle;
mod minimal;
mod problem;
mod types;
mod validate;
mod view_check;
mod words;

pub use args::{Sources, fill_args, pressed_row};
pub use lifecycle::{IssueAge, PinError, VersionAge, arrange_pins, issues_to_drop, pin_slot, versions_to_drop};
pub use minimal::minimal_data;
pub use problem::{Problem, format_problems};
pub use types::{Contract, Field, MAX_DEPTH, Type};
pub use validate::{Validation, validate};
pub use view_check::{Binding, view_check};
pub use words::{IssueKind, IssueStatus, Level, MadeBy, Place, Role, VersionStatus};
