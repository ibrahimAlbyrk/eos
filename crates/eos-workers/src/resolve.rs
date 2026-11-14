//! Which definition a spawn gets and what it takes from it.

use std::collections::HashSet;

use eos_contracts::{
    DEFAULT_WORKER_DEFINITION, Effort, PermissionMode, ToolScope, WorkerDefinition, WorkerDefinitionRecord,
    WorkerIsolation,
};

use crate::definition::definition;

/// The definition name a spawn resolves to: `from` when it names one, the
/// `git` built-in for the legacy `role: "git"`, else the general-purpose
/// default. A spawn always names a definition.
pub fn resolve_definition_name<'a>(from: Option<&'a str>, role: Option<&str>) -> &'a str {
    match from.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => name,
        None if role == Some("git") => "git",
        None => DEFAULT_WORKER_DEFINITION,
    }
}

fn last_by_name<'a>(name: &str, records: &'a [WorkerDefinitionRecord]) -> Option<&'a WorkerDefinitionRecord> {
    records.iter().rev().find(|r| r.name == name)
}

/// The definition `name` stands for. `records` run from lowest to highest
/// precedence: the last one of that name wins entirely, then its `extends`
/// chain fills the fields it leaves unset. `None` when nothing has that name.
pub fn resolve_by_name(name: &str, records: &[WorkerDefinitionRecord]) -> Option<WorkerDefinition> {
    if name.is_empty() {
        return None;
    }
    let winner = last_by_name(name, records)?;
    Some(resolve_extends(winner, records, &mut HashSet::new()))
}

/// The child's set fields over its resolved base. A chain that loops or
/// names a base nobody defines stops there.
fn resolve_extends(
    record: &WorkerDefinitionRecord,
    records: &[WorkerDefinitionRecord],
    seen: &mut HashSet<String>,
) -> WorkerDefinition {
    let child = definition(record.clone());
    let Some(base_name) = record.extends.as_deref().filter(|base| !base.is_empty()) else { return child };
    if !seen.insert(record.name.clone()) {
        return child;
    }
    let Some(base_record) = last_by_name(base_name, records) else { return child };
    overlay(resolve_extends(base_record, records, seen), child)
}

/// A field the child sets wins; one it leaves unset comes from the base. The
/// text fields are always set (empty when the file gave none), so a child's
/// always win. `extends` is used up here.
fn overlay(base: WorkerDefinition, child: WorkerDefinition) -> WorkerDefinition {
    WorkerDefinition {
        name: child.name,
        description: child.description,
        when_to_use: child.when_to_use,
        model: child.model.or(base.model),
        effort: child.effort.or(base.effort),
        permission_mode: child.permission_mode.or(base.permission_mode),
        backend_kind: child.backend_kind.or(base.backend_kind),
        backend_profile: child.backend_profile.or(base.backend_profile),
        persistent: child.persistent.or(base.persistent),
        collaborate: child.collaborate.or(base.collaborate),
        isolation: child.isolation.or(base.isolation),
        tools_allow: child.tools_allow.or(base.tools_allow),
        tools_deny: child.tools_deny.or(base.tools_deny),
        edit_regex: child.edit_regex.or(base.edit_regex),
        extends: None,
        body: child.body,
    }
}

/// What a definition pre-fills on a spawn: only fields the request left unset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DefinitionDefaults {
    pub model: Option<String>,
    pub effort: Option<Effort>,
    pub permission_mode: Option<PermissionMode>,
    pub backend_kind: Option<String>,
    pub backend_profile: Option<String>,
    pub persistent: Option<bool>,
    pub collaborate: Option<bool>,
    pub isolation: Option<WorkerIsolation>,
}

/// The defaults `definition` gives a request. `request_has` says whether the
/// request set a field (by its wire name): a set field is never overridden.
pub fn apply_defaults(definition: &WorkerDefinition, request_has: impl Fn(&str) -> bool) -> DefinitionDefaults {
    let d = definition;
    DefinitionDefaults {
        model: d.model.clone().filter(|_| !request_has("model")),
        effort: d.effort.filter(|_| !request_has("effort")),
        permission_mode: d.permission_mode.filter(|_| !request_has("permissionMode")),
        backend_kind: d.backend_kind.clone().filter(|_| !request_has("backendKind")),
        backend_profile: d.backend_profile.clone().filter(|_| !request_has("backendProfile")),
        persistent: d.persistent.filter(|_| !request_has("persistent")),
        collaborate: d.collaborate.filter(|_| !request_has("collaborate")),
        isolation: d.isolation.filter(|_| !request_has("isolation")),
    }
}

/// `<provider>/<model>` as a backend profile and a model, when `<provider>`
/// is a configured backend; everything after the first `/` is the model.
/// A bare id, an unknown prefix, or an empty side stays one model.
pub fn split_provider_model(model: &str, is_backend: impl Fn(&str) -> bool) -> (Option<&str>, &str) {
    match model.split_once('/') {
        Some((prefix, rest)) if !prefix.is_empty() && !rest.is_empty() && is_backend(prefix) => (Some(prefix), rest),
        _ => (None, model),
    }
}

/// The model and backend profile a `provider/model` value stands for, given
/// the profile already pinned. The prefix becomes the profile when none is
/// pinned or it is the pinned one (a redundant prefix is stripped); a prefix
/// naming another profile is that profile's own model id and stays whole.
pub fn resolve_combined_model(
    model: Option<&str>,
    pinned_profile: Option<&str>,
    is_backend: impl Fn(&str) -> bool,
) -> (Option<String>, Option<String>) {
    let pinned = pinned_profile.filter(|profile| !profile.is_empty());
    let Some(model) = model.filter(|model| !model.is_empty()) else {
        return (model.map(str::to_owned), pinned_profile.map(str::to_owned));
    };
    match split_provider_model(model, is_backend) {
        (Some(profile), bare) if pinned.is_none_or(|p| p == profile) => {
            (Some(bare.to_owned()), Some(profile.to_owned()))
        }
        _ => (Some(model.to_owned()), pinned_profile.map(str::to_owned)),
    }
}

/// `editRegex` is tested against absolute paths, but authors write
/// `^src/`: that becomes `(^|/)src/` (the start, or a path segment). `^/…`
/// and patterns without `^` stay as written.
fn normalize_edit_regex(pattern: &str) -> String {
    match pattern.strip_prefix('^') {
        Some(rest) if !rest.starts_with('/') => format!("(^|/){rest}"),
        _ => pattern.to_owned(),
    }
}

/// The tool scope a definition bakes onto its worker at spawn.
pub fn materialize_tool_scope(definition: &WorkerDefinition) -> ToolScope {
    tool_scope(definition.tools_allow.as_deref(), definition.tools_deny.as_deref(), definition.edit_regex.as_deref())
}

/// A tool scope from its parts, as a definition or a one-off request names them.
pub fn tool_scope(allow: Option<&[String]>, deny: Option<&[String]>, edit_regex: Option<&str>) -> ToolScope {
    ToolScope {
        allow: allow.unwrap_or_default().to_vec(),
        deny: deny.unwrap_or_default().to_vec(),
        edit_regex: edit_regex.map(normalize_edit_regex),
    }
}

/// Whether a scope restricts anything; one that does not is stored as none.
pub fn is_restrictive(scope: &ToolScope) -> bool {
    !scope.allow.is_empty() || !scope.deny.is_empty() || scope.edit_regex.is_some()
}
