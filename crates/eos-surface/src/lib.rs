//! Routine surfaces: the interfaces a run answers with outside a chat (a View
//! now; Pages and Apps later). This crate holds their pure rules: the type
//! language data, action arguments and query arguments are written in, the
//! check of data against a contract, the least data a contract accepts, and
//! how versions, issues and pins move and age, and what a View outside a
//! chat must bind, what a Page's template and style may be made of, and
//! which edits in place its data takes, and what an App's code and manifest
//! may hold.
//! Nothing here is async, reads a clock or touches a file; the feature
//! `eos-mod-surfaces` stores and serves what these rules decide.

pub mod css;
pub mod limits;
pub mod render;
pub mod template;

mod app;
mod app_files;
mod app_test;
mod args;
mod arrange;
mod design;
mod edit;
mod lifecycle;
mod minimal;
mod problem;
mod prompt;
mod tile;
mod types;
mod validate;
mod view_check;
mod words;

pub use app::{APP_HEIGHT, APP_HTML_BYTES, APP_TESTS_BYTES, AppDesign, AppManifest, FileRoot, FileScope};
pub use app_files::{APP_FILE_BYTES, APP_FILES_LISTED, app_path, glob_matches};
pub use app_test::{APP_CSP, APP_TEST_CSP, APP_TEST_JS, APP_TEST_WIDTH, app_test_document};
pub use args::{Sources, fill_args, pressed_row};
pub use arrange::{ArrangeOp, arrange};
pub use design::PageDesign;
pub use edit::{Edited, FieldEdit, apply_edit};
pub use lifecycle::{IssueAge, PinError, VersionAge, arrange_pins, issues_to_drop, pin_slot, versions_to_drop};
pub use minimal::minimal_data;
pub use problem::{Problem, format_problems};
pub use prompt::page_catalog_prompt;
pub use tile::{TileSpec, TileText};
pub use types::{Contract, Field, MAX_DEPTH, Type};
pub use validate::{Validation, validate};
pub use view_check::{Binding, view_check};
pub use words::{IssueKind, IssueStatus, Level, MadeBy, Place, Role, VersionStatus};
