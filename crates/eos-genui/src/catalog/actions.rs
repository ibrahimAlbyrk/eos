//! The `actions` of a view: what a button does when clicked.

use indexmap::{IndexMap, IndexSet};

use super::entities::{ACTION, ACTION_FIELDS};
use super::limits::{GENUI_LIMITS, HREF_OK, NAME_RE, STATE_HOLE_RE};
use super::problems::{ViewProblem, issue_problems, key_path, show};
use crate::js::{self, OBJECT_PROTOTYPE_KEYS};
use crate::re::is_match;
use crate::value::Value;

#[derive(Debug, Default)]
pub(crate) struct ActionInfo<'a> {
    /// Every key of `actions`, valid or not, in order.
    pub(crate) ids: IndexSet<&'a str>,
    pub(crate) kinds: IndexMap<&'a str, &'a str>,
    pub(crate) set_keys: IndexSet<&'a str>,
    pub(crate) primary: usize,
    /// `{state.key}` holes in action text/href, checked once every bind= is known.
    pub(crate) state_refs: Vec<StateRef>,
}

#[derive(Debug)]
pub(crate) struct StateRef {
    pub(crate) path: String,
    pub(crate) key: String,
}

pub(crate) fn validate_actions<'a>(
    actions: Option<&'a Value>,
    problems: &mut Vec<ViewProblem>,
    warnings: &mut Vec<ViewProblem>,
) -> ActionInfo<'a> {
    let mut out = ActionInfo::default();
    let Some(actions) = actions else { return out };
    let Value::Object(actions) = actions else {
        problems.push(ViewProblem::new(
            "actions",
            format!("must be an object of {{id: {{label, kind, …}}}}, got {}", show(Some(actions))),
        ));
        return out;
    };
    let mut primary: Vec<&str> = Vec::new();
    for (id, raw) in actions.iter() {
        let path = key_path("actions", id);
        out.ids.insert(id);
        if !is_match(&NAME_RE, id) {
            problems.push(ViewProblem::new(path, "is not a usable action id — letters, digits, _ or -"));
            continue;
        }
        let issues = ACTION.check(Some(raw));
        if !issues.is_empty() {
            problems.extend(issue_problems(&path, Some(raw), &issues));
            continue;
        }
        // The schema passed, so `raw` is an object whose known fields have their types.
        let Value::Object(a) = raw else { continue };
        let kind = a.get("kind").and_then(Value::as_str).unwrap_or_default();
        out.kinds.insert(id, kind);
        for extra in a.keys() {
            // The TypeScript asks `extra in shape`, which inherited members answer too.
            if !ACTION_FIELDS.contains(&extra) && !OBJECT_PROTOTYPE_KEYS.contains(&extra) {
                warnings.push(ViewProblem::new(format!("{path}.{extra}"), "is not an action field — ignored"));
            }
        }
        if a.get("primary") == Some(&Value::Bool(true)) {
            primary.push(id);
        }
        let text = a.get("text").and_then(Value::as_str).unwrap_or_default();
        let href = a.get("href").and_then(Value::as_str).unwrap_or_default();
        for (field, value) in [("text", text), ("href", href)] {
            for m in STATE_HOLE_RE.find_iter(value) {
                if let Some(key) = m.group(1) {
                    out.state_refs.push(StateRef { path: format!("{path}.{field}"), key: value[key].to_owned() });
                }
            }
        }
        if (kind == "prefill" || kind == "copy") && text.is_empty() {
            problems.push(ViewProblem::new(format!("{path}.text"), format!("is required for kind \"{kind}\"")));
        }
        if kind == "open" {
            if href.is_empty() {
                problems.push(ViewProblem::new(
                    format!("{path}.href"),
                    "is required for kind \"open\" (a URL, file path or maps:{geo})",
                ));
            } else if !is_match(&HREF_OK, js::trim(href)) {
                problems.push(ViewProblem::new(
                    format!("{path}.href"),
                    format!("{} must be an http(s) URL, a file path, maps:, mailto: or tel:", show(a.get("href"))),
                ));
            }
        }
        if kind == "set" {
            // Zod's record output drops a "__proto__" key.
            let keys: Vec<&str> = a
                .get("set")
                .and_then(Value::as_object)
                .map(|set| set.keys().filter(|k| *k != "__proto__").collect())
                .unwrap_or_default();
            if keys.is_empty() {
                problems
                    .push(ViewProblem::new(format!("{path}.set"), "is required for kind \"set\" — {stateKey: value}"));
            }
            out.set_keys.extend(keys);
        }
    }
    out.primary = primary.len();
    if primary.len() > GENUI_LIMITS.primary_actions {
        problems.push(ViewProblem::new(
            "actions",
            format!(
                "{} are primary ({}), max {} — keep the main one or two",
                primary.len(),
                primary.join(", "),
                GENUI_LIMITS.primary_actions
            ),
        ));
    }
    out
}
