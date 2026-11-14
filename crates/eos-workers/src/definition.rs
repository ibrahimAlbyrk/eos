//! From a definition file to a validated record.

use eos_contracts::{WorkerDefinition, WorkerDefinitionRecord, WorkerDefinitionSource};
use eos_core::store::DefinitionFile;
use serde_json::{Map, Value};

/// The definition's optional fields. A `null` there is not "unset": the file
/// is invalid, as it is for today's reader.
const OPTIONAL_FIELDS: &[&str] = &[
    "model",
    "effort",
    "permissionMode",
    "backendKind",
    "backendProfile",
    "persistent",
    "collaborate",
    "isolation",
    "toolsAllow",
    "toolsDeny",
    "editRegex",
    "extends",
];

/// The definition a frontmatter and a body make; `None` when they make none
/// (no `name`, a field of the wrong type). The body always comes from the
/// file, whatever the frontmatter says.
pub fn definition_from(frontmatter: &Value, body: &str) -> Option<WorkerDefinition> {
    let mut fields = match frontmatter {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    fields.insert("body".to_owned(), Value::String(body.to_owned()));
    if OPTIONAL_FIELDS.iter().any(|key| fields.get(*key).is_some_and(Value::is_null)) {
        return None;
    }
    eos_contracts::validate::parse(&Value::Object(fields)).ok()
}

/// A definition with where it came from.
pub fn record(definition: WorkerDefinition, source: WorkerDefinitionSource) -> WorkerDefinitionRecord {
    WorkerDefinitionRecord {
        name: definition.name,
        description: definition.description,
        when_to_use: definition.when_to_use,
        model: definition.model,
        effort: definition.effort,
        permission_mode: definition.permission_mode,
        backend_kind: definition.backend_kind,
        backend_profile: definition.backend_profile,
        persistent: definition.persistent,
        collaborate: definition.collaborate,
        isolation: definition.isolation,
        tools_allow: definition.tools_allow,
        tools_deny: definition.tools_deny,
        edit_regex: definition.edit_regex,
        extends: definition.extends,
        body: definition.body,
        source,
    }
}

/// A record without its source.
pub fn definition(record: WorkerDefinitionRecord) -> WorkerDefinition {
    WorkerDefinition {
        name: record.name,
        description: record.description,
        when_to_use: record.when_to_use,
        model: record.model,
        effort: record.effort,
        permission_mode: record.permission_mode,
        backend_kind: record.backend_kind,
        backend_profile: record.backend_profile,
        persistent: record.persistent,
        collaborate: record.collaborate,
        isolation: record.isolation,
        tools_allow: record.tools_allow,
        tools_deny: record.tools_deny,
        edit_regex: record.edit_regex,
        extends: record.extends,
        body: record.body,
    }
}

/// The records of a list of files, in order. A later file of the same name
/// replaces an earlier one and keeps its place; a file that is not a valid
/// definition does not appear.
pub fn records_from(files: &[DefinitionFile]) -> Vec<WorkerDefinitionRecord> {
    let mut records: Vec<WorkerDefinitionRecord> = Vec::new();
    for file in files {
        let Some(definition) = definition_from(&file.frontmatter, &file.body) else { continue };
        let next = record(definition, file.source);
        match records.iter_mut().find(|r| r.name == next.name) {
            Some(slot) => *slot = next,
            None => records.push(next),
        }
    }
    records
}
