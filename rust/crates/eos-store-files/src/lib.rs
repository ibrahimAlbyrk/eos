//! The data folder's files that are not the database, behind the ports of
//! `eos-core`. Each store keeps today's file format, holds the file in
//! memory, and replaces it atomically on every change.

mod json;
mod models;
mod projects;
mod recents;

pub use models::CachedModelCatalog;
pub use projects::JsonProjects;
pub use recents::JsonRecents;
