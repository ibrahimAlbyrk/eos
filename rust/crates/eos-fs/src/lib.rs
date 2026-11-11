//! The user's own files and the desktop around them.
//!
//! - [`DiskFileSystem`]: the `FileSystem` port over the real disk — what the
//!   Files panel, the viewers and the editor read and change.
//! - [`DesktopApps`]: the `DesktopFiles` port — default apps and their icons,
//!   installed editors, opening and revealing paths — over the platform seam.
//!
//! Disk work is blocking and runs off the async threads.

mod desktop;
mod errors;
mod files;

pub use desktop::DesktopApps;
pub use errors::node_message;
pub use files::DiskFileSystem;
