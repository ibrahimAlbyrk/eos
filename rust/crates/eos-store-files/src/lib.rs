//! The data folder's files that are not the database, behind the ports of
//! `eos-core`. Each store keeps today's file format. The JSON stores
//! (projects, recent folders, the model list) hold their file in memory and
//! replace it atomically on every change; the hand-editable ones
//! (`policy.yaml`, templates, worker definitions, prompt overrides) are read
//! fresh, so an edit made outside the app applies at once.

pub mod avatar_thumbnails;
pub mod claude_md;
mod json;
pub mod memories;
mod models;
pub mod pages;
pub mod policy;
pub mod profile;
pub mod project_memory;
mod projects;
pub mod prompts;
mod recents;
pub mod remote;
pub mod sync_dir;
pub mod templates;
pub mod worker_definitions;
mod yaml_value;

pub use models::CachedModelCatalog;
pub use projects::JsonProjects;
pub use recents::JsonRecents;
