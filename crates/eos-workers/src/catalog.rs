//! The available workers an orchestrator sees, and the catalog text of its
//! prompt.

use eos_contracts::{WorkerDefinitionCatalogEntry, WorkerDefinitionRecord};

/// The files' definitions with the orchestrator's own over them: a runtime
/// definition replaces a file's of the same name in place, a new name is
/// appended.
pub fn merge_available(
    disk: Vec<WorkerDefinitionRecord>,
    runtime: Vec<WorkerDefinitionRecord>,
) -> Vec<WorkerDefinitionRecord> {
    let mut merged: Vec<WorkerDefinitionRecord> = Vec::with_capacity(disk.len() + runtime.len());
    for record in disk.into_iter().chain(runtime) {
        match merged.iter_mut().find(|r| r.name == record.name) {
            Some(slot) => *slot = record,
            None => merged.push(record),
        }
    }
    merged
}

/// What `GET /worker-definitions` (and `list_available_workers`) lists.
pub fn entries(records: &[WorkerDefinitionRecord]) -> Vec<WorkerDefinitionCatalogEntry> {
    records
        .iter()
        .map(|r| WorkerDefinitionCatalogEntry {
            name: r.name.clone(),
            description: r.description.clone(),
            when_to_use: r.when_to_use.clone(),
            source: r.source,
        })
        .collect()
}

/// What JavaScript's `\s` matches.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// One line: runs of whitespace become a space, the ends are trimmed.
fn one_line(text: &str) -> String {
    let mut line = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            pending_space = !line.is_empty();
        } else {
            if std::mem::take(&mut pending_space) {
                line.push(' ');
            }
            line.push(c);
        }
    }
    line
}

/// The catalog in an orchestrator's prompt (`AVAILABLE_WORKERS_CATALOG`):
/// one line per definition — its name, the defaults it sets
/// (`[model/effort/permission]`, unset ones left out), then when to use it.
pub fn render_catalog(records: &[WorkerDefinitionRecord]) -> String {
    let lines: Vec<String> = records
        .iter()
        .map(|r| {
            let effort =
                r.effort.and_then(|e| serde_json::to_value(e).ok()).and_then(|v| v.as_str().map(str::to_owned));
            let mode = r
                .permission_mode
                .and_then(|m| serde_json::to_value(m).ok())
                .and_then(|v| v.as_str().map(str::to_owned));
            let axes: Vec<&str> = [r.model.as_deref(), effort.as_deref(), mode.as_deref()]
                .into_iter()
                .flatten()
                .filter(|axis| !axis.is_empty())
                .collect();
            let head =
                if axes.is_empty() { format!("- {}", r.name) } else { format!("- {} [{}]", r.name, axes.join("/")) };
            let hint = one_line(if r.when_to_use.is_empty() { &r.description } else { &r.when_to_use });
            if hint.is_empty() { head } else { format!("{head}: {hint}") }
        })
        .collect();
    lines.join("\n")
}
