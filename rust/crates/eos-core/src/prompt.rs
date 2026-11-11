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

/// One prompt file as read: its id, its frontmatter as data and its body.
#[derive(Debug, Clone, PartialEq)]
pub struct RawPrompt {
    /// The frontmatter's `id` when it has one, else the file's path under the
    /// library without the `.prompt.md` ending (`role/worker/10-report`).
    pub id: String,
    /// The frontmatter as data (mapping keys are strings); an empty object
    /// when the file has none or it is not YAML.
    pub frontmatter: serde_json::Value,
    /// Everything after the frontmatter, verbatim.
    pub body: String,
    /// Where it was read from, for messages about a broken file.
    pub source_path: Option<String>,
}

/// The prompt library (`core/src/ports/PromptSource.ts`): the prompts shipped
/// with the app, with the user's override folder over them — a file of the
/// same id replaces the shipped one. Read fresh on every call, so an edit
/// applies to the next spawn. A file that cannot be read is left out.
pub trait PromptSource: Send + Sync + 'static {
    fn list(&self) -> Vec<RawPrompt>;
}

/// The text of `{{USER_PROFILE}}` for one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileText {
    pub text: String,
    /// True when nothing of the user's is in it (the stock preferences): a
    /// focused session then gets no profile block at all.
    pub empty: bool,
}

/// Who the user is, as prompt text. Implemented by the profile feature and
/// handed to whoever assembles a system prompt (a spawn, the prompt preview).
pub trait ProfileRenderer: Send + Sync + 'static {
    /// `kind` is the session's backend kind (the user may withhold the
    /// profile from one), `project` the folder it works on. `memory` is the
    /// session's memory files when the caller has loaded them — lines the
    /// session already gets from there are not repeated; `None` lets the
    /// renderer load what a session in `project` would get.
    fn render(&self, kind: &str, project: Option<&str>, memory: Option<&MemorySnapshot>) -> ProfileText;
}
