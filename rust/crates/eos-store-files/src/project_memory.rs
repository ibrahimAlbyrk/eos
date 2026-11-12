//! Claude Code's memory of a project (`infra/src/persistence/FileProjectMemoryStore.ts`):
//! `<Claude home>/projects/<project key>/memory/<name>.md`, each file with
//! YAML frontmatter (`description`, `metadata.type`), and the `MEMORY.md` index.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use eos_contracts::{MemoryEntry, MemoryName, MemoryType};
use eos_core::store::ProjectMemoryStore;
use eos_core::{Clock, Error};
use eos_domain::claude_transcript::encode_cwd;
use eos_domain::project_memory::remove_from_index;
use eos_domain::time::iso_from_ms;
use eos_kit_fs::frontmatter;
use serde_json::Value;

const INDEX: &str = "MEMORY.md";

/// A memory's file name without `.md`: what Claude Code writes.
fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// The description and the kind a memory's frontmatter gives; a file
/// without one is a `project` memory with no description.
fn read_meta(raw: &str) -> (String, MemoryType) {
    let meta: Option<Value> = frontmatter::parse::<Value>(raw).ok().flatten().map(|(meta, _)| meta);
    let description = meta.as_ref().and_then(|m| m["description"].as_str()).unwrap_or_default().to_owned();
    let kind = meta
        .as_ref()
        .and_then(|m| serde_json::from_value(m["metadata"]["type"].clone()).ok())
        .unwrap_or(MemoryType::Project);
    (description, kind)
}

pub struct FileProjectMemory {
    claude_home: PathBuf,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FileProjectMemory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileProjectMemory").field("claude_home", &self.claude_home).finish_non_exhaustive()
    }
}

impl FileProjectMemory {
    /// `clock` stamps the name a removed memory keeps in `.trash`.
    pub fn new(claude_home: PathBuf, clock: Arc<dyn Clock>) -> Self {
        Self { claude_home, clock }
    }
}

impl ProjectMemoryStore for FileProjectMemory {
    fn dir_of(&self, project: &Path) -> PathBuf {
        // Claude Code keys a project by its real path (links and case resolved).
        let real = fs::canonicalize(project).unwrap_or_else(|_| project.to_owned());
        self.claude_home.join("projects").join(encode_cwd(&real.to_string_lossy())).join("memory")
    }

    fn list(&self, dir: &Path) -> Vec<MemoryEntry> {
        let Ok(files) = fs::read_dir(dir) else { return Vec::new() };
        let mut entries: Vec<MemoryEntry> = files
            .filter_map(Result::ok)
            .filter_map(|file| {
                let file_name = file.file_name().to_string_lossy().into_owned();
                let name = file_name.strip_suffix(".md").filter(|n| file_name != INDEX && is_name(n))?.to_owned();
                let path = file.path();
                let raw = fs::read_to_string(&path).ok()?;
                let modified = fs::metadata(&path).ok()?.modified().ok()?;
                let updated_at = modified.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
                let (description, r#type) = read_meta(&raw);
                Some(MemoryEntry {
                    name: MemoryName(name),
                    description,
                    r#type,
                    path: path.to_string_lossy().into_owned(),
                    updated_at: updated_at.into(),
                })
            })
            .collect();
        entries.sort_by(|a, b| b.updated_at.0.total_cmp(&a.updated_at.0));
        entries
    }

    fn remove(&self, dir: &Path, name: &str) -> Result<bool, Error> {
        if !is_name(name) {
            return Err(Error::Validation(format!("invalid memory name: {name}")));
        }
        let file = dir.join(format!("{name}.md"));
        if !file.exists() {
            return Ok(false);
        }
        let io = |e: std::io::Error| Error::Storage(format!("{}: {e}", dir.display()));
        let trash = dir.join(".trash");
        fs::create_dir_all(&trash).map_err(io)?;
        // `2026-11-12T10-20-30-123`: the time, safe for a file name.
        let stamp = iso_from_ms(self.clock.now_ms()).replace([':', '.'], "-");
        let stamp = stamp.strip_suffix('Z').unwrap_or(&stamp);
        fs::rename(&file, trash.join(format!("{name}.{stamp}.md"))).map_err(io)?;
        let index = dir.join(INDEX);
        let text = fs::read_to_string(&index).unwrap_or_default();
        let tmp = dir.join(format!("{INDEX}.tmp"));
        fs::write(&tmp, remove_from_index(&text, name)).map_err(io)?;
        fs::rename(&tmp, &index).map_err(io)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use eos_testkit::FakeClock;

    use super::*;

    const MEMORY: &str = "---\nname: tabs_in_go\ndescription: Go files use tabs and gofmt\nmetadata:\n  type: feedback\n---\n\nUse tabs.\n";

    #[test]
    fn a_project_memory_is_listed_and_removed_into_the_trash() {
        let home = tempfile::tempdir().expect("a folder");
        let store = FileProjectMemory::new(home.path().join(".claude"), Arc::new(FakeClock::new()));
        let project = home.path().join("my project");
        fs::create_dir(&project).expect("the project");
        let dir = store.dir_of(&project);
        assert!(dir.ends_with("memory") && dir.to_string_lossy().contains("-my-project"), "{}", dir.display());
        assert!(store.list(&dir).is_empty(), "no folder yet");

        fs::create_dir_all(&dir).expect("the memory folder");
        fs::write(dir.join("tabs_in_go.md"), MEMORY).expect("a memory");
        fs::write(dir.join("plain.md"), "no frontmatter").expect("another");
        fs::write(dir.join("Not-A-Name.md"), "x").expect("a stray file");
        fs::write(dir.join(INDEX), "- [Tabs](tabs_in_go.md) — gofmt\n- [Plain](plain.md)\n").expect("the index");
        let mut listed: Vec<(String, String, MemoryType)> =
            store.list(&dir).into_iter().map(|e| (e.name.0, e.description, e.r#type)).collect();
        listed.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            listed,
            [
                ("plain".to_owned(), String::new(), MemoryType::Project),
                ("tabs_in_go".to_owned(), "Go files use tabs and gofmt".to_owned(), MemoryType::Feedback)
            ]
        );

        assert_eq!(store.remove(&dir, "tabs_in_go"), Ok(true));
        assert_eq!(store.remove(&dir, "tabs_in_go"), Ok(false));
        assert!(store.remove(&dir, "../x").is_err());
        assert_eq!(fs::read_to_string(dir.join(INDEX)).expect("the index"), "- [Plain](plain.md)\n");
        let trashed: Vec<String> = fs::read_dir(dir.join(".trash"))
            .expect("the trash")
            .map(|e| e.expect("an entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(trashed.len(), 1);
        assert!(trashed[0].starts_with("tabs_in_go.") && !trashed[0].contains(':'), "{trashed:?}");
    }
}
