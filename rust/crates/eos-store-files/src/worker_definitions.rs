//! Worker-definition files (`infra/src/worker-definition/FileWorkerDefinitionSource.ts`):
//! the built-in ones shipped in the binary, the user's under
//! `<data folder>/workers`, and a project's under the nearest `.eos/workers`.

use std::fs;
use std::path::{Path, PathBuf};

use eos_contracts::WorkerDefinitionSource;
use eos_core::store::{DefinitionFile, WorkerDefinitionFiles};
use eos_kit_fs::path::normalize;
use serde_json::Value;

use crate::yaml_value;

/// The definitions shipped with the app, by name.
pub const BUILTIN_DEFINITIONS: &[(&str, &str)] = &[
    ("explorer.md", include_str!("../assets/workers/explorer.md")),
    ("general-purpose.md", include_str!("../assets/workers/general-purpose.md")),
    ("git.md", include_str!("../assets/workers/git.md")),
    ("researcher.md", include_str!("../assets/workers/researcher.md")),
];

/// A definitions folder is shallow; this only stops a runaway tree.
const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone)]
pub struct FsWorkerDefinitionFiles {
    user_dir: PathBuf,
}

impl FsWorkerDefinitionFiles {
    /// `user_dir` is `<data folder>/workers`; it need not exist.
    pub fn new(user_dir: impl Into<PathBuf>) -> Self {
        Self { user_dir: user_dir.into() }
    }
}

/// This reader's own fence: the file starts with `---` and a line feed, and
/// the frontmatter ends at the first line that is exactly `---` followed by a
/// line feed. Anything else is a file without frontmatter.
fn split(text: &str) -> (Option<&str>, &str) {
    if !text.starts_with("---\n") {
        return (None, text);
    }
    match text[4..].find("\n---\n") {
        Some(at) => (Some(&text[4..4 + at]), &text[4 + at + 5..]),
        None => (None, text),
    }
}

/// A file's frontmatter and body; `None` when its frontmatter is not YAML.
fn read(text: &str, source: WorkerDefinitionSource) -> Option<DefinitionFile> {
    let (frontmatter, body) = split(text);
    let frontmatter = match frontmatter.filter(|yaml| !yaml.is_empty()) {
        Some(yaml) => yaml_value::parse(yaml).ok()?,
        None => Value::Null,
    };
    Some(DefinitionFile { source, frontmatter, body: body.to_owned() })
}

/// Every `.md` file under `dir`, folders first-come in name order. Links are
/// not followed.
fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if depth < MAX_DEPTH {
                walk(&entry.path(), depth + 1, out);
            }
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".md") {
            out.push(entry.path());
        }
    }
}

/// The nearest `.eos/workers` folder at or above `cwd`.
pub fn find_project_dir(cwd: &Path) -> Option<PathBuf> {
    let start = if cwd.is_absolute() { normalize(cwd) } else { normalize(&std::env::current_dir().ok()?.join(cwd)) };
    start.ancestors().map(|dir| dir.join(".eos").join("workers")).find(|candidate| candidate.is_dir())
}

impl WorkerDefinitionFiles for FsWorkerDefinitionFiles {
    fn list(&self, cwd: Option<&Path>) -> Vec<DefinitionFile> {
        let mut files: Vec<DefinitionFile> =
            BUILTIN_DEFINITIONS.iter().filter_map(|(_, text)| read(text, WorkerDefinitionSource::Builtin)).collect();
        let project = cwd.and_then(find_project_dir);
        let folders =
            [(Some(self.user_dir.clone()), WorkerDefinitionSource::User), (project, WorkerDefinitionSource::Project)];
        for (dir, source) in folders {
            let Some(dir) = dir else { continue };
            let mut paths = Vec::new();
            walk(&dir, 0, &mut paths);
            files.extend(
                paths.iter().filter_map(|path| fs::read_to_string(path).ok()).filter_map(|text| read(&text, source)),
            );
        }
        files
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fence_is_this_readers_own() {
        assert_eq!(split("---\nname: a\n---\nbody\n"), (Some("name: a"), "body\n"));
        assert_eq!(split("---\n\n---\nbody\n"), (Some(""), "body\n"));
        assert_eq!(split("---\nname: a\n---"), (None, "---\nname: a\n---"), "the closing fence needs its line feed");
        assert_eq!(split("---\r\nname: a\r\n---\r\nbody"), (None, "---\r\nname: a\r\n---\r\nbody"));
        assert_eq!(split("# none\n"), (None, "# none\n"));
        assert_eq!(split("---\na: 1\n---\nx\n---\nb: 2\n---\n"), (Some("a: 1"), "x\n---\nb: 2\n---\n"));
    }
}
