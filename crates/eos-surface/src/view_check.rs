//! What a View outside a chat must hold besides what `present` checks. There
//! is no conversation for a `send` to become a turn in, so every `send` is
//! bound to a declared direct action with an argument template the core fills
//! from the stored issue; the frame never passes arguments of its own.
//! `prefill` writes into a chat box that does not exist, so it is refused.
//!
//! Runs after `eos_genui::validate_view` accepted the same view.

use serde_json::{Map, Value};

use crate::problem::{Problem, field_path};

/// One bound `send`: the registry action it runs and its argument template.
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub view_action: String,
    pub action: String,
    /// String values may hold `{data.path}` or `{state.key}` slots, and
    /// `{item.path}` for a button inside the rows of `list`.
    pub args: Map<String, Value>,
    /// The data path of the list whose rows the button sits in (`data.stories`).
    pub list: Option<String>,
}

/// Roots a slot in an argument template may start from: the issue's stored
/// data, and the View's saved state (what the user typed or chose); and the
/// pressed row, for a button inside a list's rows.
const SLOT_ROOTS: &[&str] = &["data", "state"];
const ROW_ROOT: &str = "item";

/// Checks `view`'s actions against `bindings` (`{viewActionId: {action, args}}`)
/// and answers the bindings, or every problem. `is_action` says whether a
/// registry action id exists and is in scope for the surface's routine.
pub fn view_check(
    view: &Value,
    bindings: Option<&Value>,
    is_action: impl Fn(&str) -> bool,
) -> Result<Vec<Binding>, Vec<Problem>> {
    let mut problems = Vec::new();
    let empty = Map::new();
    let actions = view.get("actions").and_then(Value::as_object).unwrap_or(&empty);
    let bindings = match bindings {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(map)) => map,
        Some(_) => return Err(vec![Problem::new("bindings", "must be an object of {actionId: {action, args}}")]),
    };
    for (id, action) in actions {
        let path = field_path("view.actions", id);
        match action.get("kind").and_then(Value::as_str) {
            Some("prefill") => problems.push(Problem::new(
                field_path(&path, "kind"),
                "prefill has no chat to write into outside a chat; bind a send instead",
            )),
            Some("send") if !bindings.contains_key(id) => {
                problems.push(Problem::new(&path, "is a send with no entry in bindings; name the action it runs"))
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    for (id, spec) in bindings {
        let path = field_path("bindings", id);
        let kind = actions.get(id).and_then(|a| a.get("kind")).and_then(Value::as_str);
        if kind != Some("send") {
            problems.push(Problem::new(&path, "binds no send action of the view"));
            continue;
        }
        if let Some(binding) = read_binding(id, spec, &path, &is_action, &mut problems) {
            out.push(binding);
        }
    }
    if problems.is_empty() { Ok(out) } else { Err(problems) }
}

fn read_binding(
    id: &str,
    spec: &Value,
    path: &str,
    is_action: &impl Fn(&str) -> bool,
    problems: &mut Vec<Problem>,
) -> Option<Binding> {
    let Some(spec) = spec.as_object() else {
        problems.push(Problem::new(path, "must be {action, args}"));
        return None;
    };
    for key in spec.keys().filter(|k| !matches!(k.as_str(), "action" | "args" | "list")) {
        problems.push(Problem::new(field_path(path, key), "is not a binding field"));
    }
    let action = spec.get("action").and_then(Value::as_str).unwrap_or_default();
    if action.is_empty() {
        problems.push(Problem::new(field_path(path, "action"), "is required: a direct action id"));
        return None;
    }
    if !is_action(action) {
        problems
            .push(Problem::new(field_path(path, "action"), format!("{action} is not an action this routine may run")));
        return None;
    }
    let args = match spec.get("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(args)) => args.clone(),
        Some(_) => {
            problems.push(Problem::new(field_path(path, "args"), "must be an object"));
            return None;
        }
    };
    let list = match spec.get("list") {
        None | Some(Value::Null) => None,
        Some(Value::String(list)) if list.starts_with("data.") && !list.split('.').any(str::is_empty) => {
            Some(list.clone())
        }
        Some(_) => {
            problems
                .push(Problem::new(field_path(path, "list"), "must name data.<path> of the list the button sits in"));
            return None;
        }
    };
    let before = problems.len();
    check_slots(&Value::Object(args.clone()), &field_path(path, "args"), list.is_some(), problems);
    (problems.len() == before).then(|| Binding { view_action: id.to_owned(), action: action.to_owned(), args, list })
}

fn check_slots(value: &Value, path: &str, in_rows: bool, problems: &mut Vec<Problem>) {
    match value {
        Value::String(text) => {
            for slot in slots(text) {
                let root = slot.split('.').next().unwrap_or_default();
                let known = SLOT_ROOTS.contains(&root) || (in_rows && root == ROW_ROOT);
                if !known || slot.split('.').any(str::is_empty) {
                    let message = if in_rows {
                        format!("{{{slot}}} must name data.<path>, state.<key> or item.<path>")
                    } else if root == ROW_ROOT {
                        format!("{{{slot}}} names a row: give the binding the list its button sits in")
                    } else {
                        format!("{{{slot}}} must name data.<path> or state.<key>")
                    };
                    problems.push(Problem::new(path, message));
                }
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                check_slots(item, &format!("{path}[{i}]"), in_rows, problems);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                check_slots(item, &field_path(path, key), in_rows, problems);
            }
        }
        _ => {}
    }
}

/// The `{…}` slots of a template string, without their braces.
pub(crate) fn slots(text: &str) -> impl Iterator<Item = &str> {
    text.split('{').skip(1).filter_map(|rest| rest.split_once('}').map(|(slot, _)| slot))
}
