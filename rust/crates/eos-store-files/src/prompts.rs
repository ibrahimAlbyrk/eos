//! The prompt library (`infra/src/prompt/FilePromptSource.ts`): the prompts
//! shipped in the binary, with override folders over them
//! (`<data folder>/prompts`). A file is `<id>.prompt.md`: YAML frontmatter
//! and a template body. An override of the same id replaces the shipped
//! prompt; a new id adds one. Override folders are read on every call.

use std::fs;
use std::path::{Path, PathBuf};

use eos_core::prompt::{PromptSource, RawPrompt};
use serde_json::{Map, Value};

use crate::yaml_value;

/// The shipped library: each file's path under it and its text, in the
/// order the library is walked.
pub const EMBEDDED_PROMPTS: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/prompts_table.rs"));

const EXT: &str = ".prompt.md";

/// A prompts folder is two or three levels deep; this only stops a runaway tree.
const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, Default)]
pub struct LibraryPromptSource {
    overrides: Vec<PathBuf>,
}

impl LibraryPromptSource {
    /// The shipped library alone.
    pub fn embedded() -> Self {
        Self::default()
    }

    /// The shipped library with `overrides` over it, the last one winning.
    /// A folder that does not exist counts for nothing.
    pub fn with_overrides(overrides: Vec<PathBuf>) -> Self {
        Self { overrides }
    }
}

/// The frontmatter between a leading `---` line and the next line that is
/// exactly `---`, and the body after it.
fn split(text: &str) -> (Option<&str>, &str) {
    if !text.starts_with("---\n") {
        return (None, text);
    }
    match text[4..].find("\n---\n") {
        Some(at) => (Some(&text[4..4 + at]), &text[4 + at + 5..]),
        None => (None, text),
    }
}

/// One file as a prompt. `relative` is its path under the library, with `/`.
/// Frontmatter that is not YAML counts as none: the body is still usable.
fn read(relative: &str, text: &str, source_path: Option<String>) -> RawPrompt {
    let (frontmatter, body) = split(text);
    let frontmatter = frontmatter
        .filter(|yaml| !yaml.is_empty())
        .and_then(|yaml| yaml_value::parse(yaml).ok())
        .filter(|value| !value.is_null())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let declared = frontmatter.get("id").and_then(Value::as_str);
    let id = declared.unwrap_or_else(|| relative.strip_suffix(EXT).unwrap_or(relative)).to_owned();
    RawPrompt { id, frontmatter, body: body.to_owned(), source_path }
}

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
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(EXT) {
            out.push(entry.path());
        }
    }
}

impl PromptSource for LibraryPromptSource {
    fn list(&self) -> Vec<RawPrompt> {
        let mut prompts: Vec<RawPrompt> = Vec::with_capacity(EMBEDDED_PROMPTS.len());
        let mut put = |prompt: RawPrompt| match prompts.iter_mut().find(|p| p.id == prompt.id) {
            Some(slot) => *slot = prompt,
            None => prompts.push(prompt),
        };
        for (relative, text) in EMBEDDED_PROMPTS {
            put(read(relative, text, None));
        }
        for dir in &self.overrides {
            let mut files = Vec::new();
            walk(dir, 0, &mut files);
            for file in files {
                let Ok(text) = fs::read_to_string(&file) else { continue };
                let relative = file.strip_prefix(dir).unwrap_or(&file);
                let relative: Vec<_> = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect();
                put(read(&relative.join("/"), &text, Some(file.display().to_string())));
            }
        }
        prompts
    }
}
