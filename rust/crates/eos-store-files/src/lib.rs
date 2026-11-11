//! The data folder's files that are not the database, behind the ports of
//! `eos-core`. Each store keeps today's file format, holds the file in
//! memory, and replaces it atomically on every change.

pub mod claude_md;
mod json;
pub mod memories;
mod models;
pub mod pages;
pub mod profile;
mod projects;
mod recents;

pub use models::CachedModelCatalog;
pub use projects::JsonProjects;
pub use recents::JsonRecents;
