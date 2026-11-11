//! Worker definitions as files (`core/src/ports/WorkerDefinitionSource.ts`).
//! The ones an orchestrator creates at runtime are the `worker_definitions`
//! table (`WorkerDefinitionRepo`).

use std::path::Path;

use eos_contracts::WorkerDefinitionSource;
use serde_json::Value;

/// One definition file as read: a markdown file with YAML frontmatter.
#[derive(Debug, Clone, PartialEq)]
pub struct DefinitionFile {
    /// Where the file comes from: shipped with the app, the user's folder, or the project's.
    pub source: WorkerDefinitionSource,
    /// The frontmatter as data (mapping keys are strings); `Null` when the
    /// file has none.
    pub frontmatter: Value,
    /// Everything after the frontmatter, verbatim.
    pub body: String,
}

/// The definition files a session in `cwd` sees, lowest precedence first:
/// the built-in ones, the user's (`<data folder>/workers`), then the
/// project's (the nearest `.eos/workers` at or above `cwd`). Each folder is
/// walked recursively in name order; a file that cannot be read, or whose
/// frontmatter is not YAML, is left out. Read fresh on every call, so an
/// edit applies to the next spawn.
pub trait WorkerDefinitionFiles: Send + Sync + 'static {
    fn list(&self, cwd: Option<&Path>) -> Vec<DefinitionFile>;
}
