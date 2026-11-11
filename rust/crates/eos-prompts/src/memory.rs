//! Memory files folded behind the assembled prompt, for a session whose
//! engine does not load them itself (`core/src/services/compose-appended-prompt.ts`,
//! `select-injectable-memory.ts`).

use eos_core::prompt::MemorySnapshot;

use crate::template::js_trim;

/// The memory a session of this backend kind must be handed: everything its
/// engine does not already load on its own.
pub fn select_injectable_memory(snapshot: &MemorySnapshot, backend_kind: &str) -> MemorySnapshot {
    MemorySnapshot {
        docs: snapshot
            .docs
            .iter()
            .filter(|doc| !doc.native_for.iter().any(|kind| kind == backend_kind))
            .cloned()
            .collect(),
    }
}

/// The files grouped under their source's heading, in the snapshot's order;
/// empty when there is nothing to show.
pub fn compose_memory_section(snapshot: &MemorySnapshot) -> String {
    let mut groups: Vec<(&str, &str, Vec<String>)> = Vec::new();
    for doc in &snapshot.docs {
        let content = js_trim(&doc.content);
        if content.is_empty() {
            continue;
        }
        let block = format!("### {}\n\n{content}", doc.path.display());
        match groups.iter_mut().find(|(id, ..)| *id == doc.source_id) {
            Some((.., blocks)) => blocks.push(block),
            None => groups.push((&doc.source_id, &doc.source_label, vec![block])),
        }
    }
    if groups.is_empty() {
        return String::new();
    }
    let sections: Vec<String> =
        groups.iter().map(|(_, label, blocks)| format!("## {label}\n\n{}", blocks.join("\n\n"))).collect();
    format!("# Project & user instructions\n\n{}", sections.join("\n\n"))
}

/// The assembled prompt with the memory after it. Without memory the prompt
/// comes back exactly as given (`None` stays `None`).
pub fn compose_appended_prompt(dpi_text: Option<&str>, memory: Option<&MemorySnapshot>) -> Option<String> {
    let section = memory.map(compose_memory_section).unwrap_or_default();
    if section.is_empty() {
        return dpi_text.map(str::to_owned);
    }
    match dpi_text.filter(|text| !js_trim(text).is_empty()) {
        Some(text) => Some(format!("{text}\n\n{section}")),
        None => Some(section),
    }
}
