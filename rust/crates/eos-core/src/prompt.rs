//! Ports for prompts: where fragments come from and how they render
//! (`core/src/ports/PromptSource.ts`, `PromptRenderer.ts`, `MemoryProvider.ts`, …).

use std::path::{Path, PathBuf};

/// Where a session works, for finding its memory files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryScope<'a> {
    pub cwd: &'a Path,
    /// The upper bound of the walk up from `cwd` (a worktree's source
    /// repository). `None`: the nearest folder with a `.git` entry, else the
    /// filesystem root.
    pub repo_root: Option<&'a Path>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryLevel {
    User,
    Project,
}

/// One memory file as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryDoc {
    /// The configured source's key, e.g. `claude`.
    pub source_id: String,
    /// Its section heading, e.g. `CLAUDE.md`.
    pub source_label: String,
    /// Backend kinds that load this source themselves: the file is never
    /// handed to them a second time.
    pub native_for: Vec<String>,
    pub path: PathBuf,
    pub level: MemoryLevel,
    pub content: String,
}

/// Grouped by source (in priority order); within a source the user's files
/// first, then the project's from the repository root down to the working
/// folder (general to specific).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MemorySnapshot {
    pub docs: Vec<MemoryDoc>,
}

/// The configured memory sources (CLAUDE.md and any AGENTS.md-style files):
/// each source's user-level files plus its file names walked from the
/// session's folder up to the repository root. A missing or unreadable file is
/// skipped: memory is context, never a reason a session cannot start.
pub trait MemoryProvider: Send + Sync + 'static {
    fn load(&self, scope: MemoryScope<'_>) -> MemorySnapshot;
}
