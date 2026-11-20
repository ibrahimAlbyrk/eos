//! The agents' file tools run inside the app's process, so a tool that opens
//! one of the database's files would cost SQLite its locks (see
//! `eos_platform`'s `database` module). Such a call is refused before the
//! policy is asked, whatever the mode or the rules say.
//!
//! Every path a call names counts, in any field: Read, Edit, Write,
//! NotebookEdit, Grep and Glob name theirs differently, and Eos's own tools
//! and the artifact tools name files too. A Grep that walks a folder above
//! the data folder skips the files through the data folder's `.ignore`,
//! unless a `glob` of its own lets them back in: that walk is refused.

use std::path::{Path, PathBuf};

use eos_agent_core::{ToolCall, Workspace};
use eos_platform::DataPaths;
use serde_json::Value;

/// Longer text is content, not a path.
const PATH_MAX: usize = 4096;

/// Why the call may not run, or `None` when it names no database file.
pub(crate) fn refusal(data: &DataPaths, call: &ToolCall<'_>) -> Option<String> {
    let input: Value = serde_json::from_str(call.input.get()).ok()?;
    let mut texts = Vec::new();
    strings(&input, &mut texts);
    if let Some(file) = texts.iter().filter_map(|text| as_path(text, call.workspace)).find(|p| data.is_database_file(p))
    {
        return Some(format!(
            "{} is one of Eos's database files. Tools never open it: that would break the running app's hold on \
             its database. Read Eos's state through Eos's own tools instead.",
            file.display()
        ));
    }
    if call.name == "Grep" && input.get("glob").and_then(Value::as_str).is_some_and(|glob| !glob.trim().is_empty()) {
        let root = match input.get("path").and_then(Value::as_str) {
            Some(path) => as_path(path, call.workspace)?,
            None => call.workspace?.cwd(),
        };
        if data.walk_reaches_database(&root) {
            return Some(format!(
                "Grep with a glob from {} would reach Eos's database files in {}. Search a folder that does not \
                 hold Eos's data folder, or leave out the glob.",
                root.display(),
                data.home().display()
            ));
        }
    }
    None
}

/// Every string in `value`, at any depth.
fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(fields) => fields.values().for_each(|field| strings(field, out)),
        _ => {}
    }
}

/// `text` as the tool would take it as a path: absolute, a leading `~` the
/// home folder, relative ones from the agent's working directory.
fn as_path(text: &str, workspace: Option<&Workspace>) -> Option<PathBuf> {
    if text.is_empty() || text.len() > PATH_MAX || text.contains('\n') {
        return None;
    }
    match workspace {
        Some(workspace) => Some(workspace.resolve_user(text)),
        None => Some(PathBuf::from(text)).filter(|path| Path::is_absolute(path)),
    }
}
