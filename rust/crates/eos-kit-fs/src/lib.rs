//! Files under the data folder, and paths that come from outside.
//!
//! - [`atomic_write`]: a reader never sees a half-written file, and a crash
//!   leaves the old file or the new one.
//! - [`PathLocks`]: read-modify-write of one file, one writer at a time.
//! - [`DocDir`]: a folder of small documents, read once and written through.
//! - [`frontmatter`]: markdown with YAML metadata, in today's on-disk layout.
//! - [`move_to_trash`], [`trash_into_dir`]: deletes that can be undone by hand.
//! - [`path`]: is this path safe to use, is it inside that root.
//! - [`walk`]: listing a tree with a depth and a size bound.
//!
//! Everything is synchronous. Nothing here knows the operating system:
//! permissions arrive as `std::fs::Permissions` from the platform seam.

mod atomic;
mod doc_dir;
mod error;
pub mod frontmatter;
mod lock;
pub mod path;
mod trash;
mod walk;
mod yaml;

pub use atomic::{WriteOptions, atomic_write};
pub use doc_dir::DocDir;
pub use error::Error;
pub use lock::{PathGuard, PathLocks};
pub use trash::{move_to_trash, trash_into_dir, trash_stamp};
pub use walk::{EntryKind, WalkEnd, WalkEntry, WalkOptions, list_files, walk};
pub use yaml::to_yaml;
