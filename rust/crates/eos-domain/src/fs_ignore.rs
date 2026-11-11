//! Folder entries hidden from project listings, search and watching: version
//! control internals, dependency caches, build output.

/// The one list; every listing, search and watcher reads it.
pub const IGNORED_ENTRIES: &[&str] = &[
    ".git",
    "node_modules",
    ".DS_Store",
    "__pycache__",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".cache",
    // A file transfer's staging: bytes not yet in place.
    ".eos-incoming",
];

pub fn is_ignored(name: &str) -> bool {
    IGNORED_ENTRIES.contains(&name)
}
