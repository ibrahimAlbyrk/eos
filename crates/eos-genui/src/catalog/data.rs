//! The `data` of a view: collections (lists of objects), scalars and sources.

use std::collections::HashSet;

use indexmap::{IndexMap, IndexSet};

use super::entities::{ENTITY, ROW, SOURCE};
use super::limits::{ENTITY_TYPES, GENUI_LIMITS, NAME_RE, RESERVED_DATA_KEYS, is_entity_type};
use super::problems::{ViewProblem, issue_problems, key_path, show};
use crate::js;
use crate::re::is_match;
use crate::value::{Object, Value};

/// What the rest of the validation needs to know about `data`.
#[derive(Debug, Default)]
pub(crate) struct DataInfo<'a> {
    /// Each collection's items; every one is an object.
    pub(crate) collections: IndexMap<&'a str, Vec<&'a Value>>,
    /// The data object itself; its keys are the data keys. `None` when data is
    /// absent or not an object.
    pub(crate) raw: Option<&'a Object>,
    pub(crate) ids: IndexMap<&'a str, IndexSet<String>>,
    pub(crate) images: HashSet<&'a str>,
    pub(crate) sites: HashSet<String>,
    pub(crate) sources_count: usize,
    /// The size of data as JSON, in bytes.
    pub(crate) bytes: usize,
}

impl DataInfo<'_> {
    pub(crate) fn has_key(&self, key: &str) -> bool {
        self.raw.is_some_and(|o| o.contains_key(key))
    }

    pub(crate) fn keys(&self) -> Vec<&str> {
        self.raw.map(|o| o.keys().collect()).unwrap_or_default()
    }

    pub(crate) fn sources_hint(&self, n: f64) -> String {
        let n = js::number_to_string(n);
        match self.sources_count {
            0 => format!("{n} but data has no sources — add data.sources [{{title, url, at}}]"),
            count => format!("{n} but data.sources has {count} — source is 1-based (1 = data.sources[0])"),
        }
    }
}

/// "63.9 KB": one decimal, dropped when it is zero.
pub(crate) fn kb(bytes: usize) -> String {
    let text = format!("{:.1}", bytes as f64 / 1024.0);
    format!("{} KB", text.strip_suffix(".0").unwrap_or(&text))
}

pub(crate) fn validate_data<'a>(
    data: Option<&'a Value>,
    problems: &mut Vec<ViewProblem>,
    warnings: &mut Vec<ViewProblem>,
) -> DataInfo<'a> {
    let mut info = DataInfo::default();
    let Some(data) = data else { return info };
    let Value::Object(data) = data else {
        problems.push(ViewProblem::new("data", format!("must be an object of collections, got {}", show(Some(data)))));
        return info;
    };
    info.raw = Some(data);
    let bytes = js::object_json_bytes(data);
    info.bytes = bytes;
    if bytes > GENUI_LIMITS.data_bytes {
        problems.push(ViewProblem::new(
            "data",
            format!("is {}, max {} — trim fields or items", kb(bytes), kb(GENUI_LIMITS.data_bytes)),
        ));
    }
    match data.get("sources") {
        None => {}
        Some(Value::Array(sources)) => {
            for (i, s) in sources.iter().enumerate() {
                problems.extend(issue_problems(&format!("data.sources[{i}]"), Some(s), &SOURCE.check(Some(s))));
            }
            info.sources_count = sources.len();
        }
        Some(_) => problems.push(ViewProblem::new("data.sources", "must be a list of {title, url, site, at, note}")),
    }
    for (key, value) in data.iter() {
        if !is_match(&NAME_RE, key) {
            problems.push(ViewProblem::new(
                key_path("data", key),
                "is not a usable name — letters, digits, _ or -, starting with a letter",
            ));
            continue;
        }
        if RESERVED_DATA_KEYS.contains(&key) {
            problems.push(ViewProblem::new(
                format!("data.{key}"),
                format!("\"{key}\" is reserved by expressions — rename it"),
            ));
            continue;
        }
        let Value::Array(value) = value else { continue };
        let items: Vec<&Value> = value.iter().filter(|x| x.as_object().is_some()).collect();
        if key == "sources" {
            info.ids.insert(key, items.iter().filter_map(|x| x.get("id")).map(|id| js::to_string(Some(id))).collect());
            info.collections.insert(key, items);
            continue;
        }
        // A list of values (labels, numbers) is a scalar, not a collection.
        if items.is_empty() {
            continue;
        }
        if let Some(bad) = value.iter().position(|x| x.as_object().is_none()) {
            problems.push(ViewProblem::new(
                format!("data.{key}[{bad}]"),
                format!("{} — a collection holds objects only", show(value.get(bad))),
            ));
            continue;
        }
        let ids = validate_items(key, value, &mut info, problems, warnings);
        info.collections.insert(key, items);
        info.ids.insert(key, ids);
    }
    info
}

fn validate_items<'a>(
    key: &str,
    items: &'a [Value],
    info: &mut DataInfo<'a>,
    problems: &mut Vec<ViewProblem>,
    warnings: &mut Vec<ViewProblem>,
) -> IndexSet<String> {
    let mut ids = IndexSet::new();
    let has_entity = items.iter().any(|x| x.get("type").is_some_and(is_entity_type));
    for (i, item) in items.iter().enumerate() {
        let path = format!("data.{key}[{i}]");
        let kind = item.get("type");
        if kind.is_some_and(is_entity_type) {
            problems.extend(issue_problems(&path, Some(item), &ENTITY.check(Some(item))));
            if kind.and_then(Value::as_str) != Some("File") && item.get("name").is_none() && item.get("title").is_none()
            {
                warnings.push(ViewProblem::new(path.clone(), "has no name or title — cards show its id"));
            }
        } else {
            // A `type` that names no entity is an ordinary field (commit kinds, file/dir);
            // only among entity rows is it likely a typo.
            if let (true, Some(Value::String(_))) = (has_entity, kind) {
                warnings.push(ViewProblem::new(
                    format!("{path}.type"),
                    format!(
                        "{} is not an entity type — this row is read as a plain row; use one of {} or rename the field",
                        show(kind),
                        ENTITY_TYPES.join(", ")
                    ),
                ));
            }
            problems.extend(issue_problems(&path, Some(item), &ROW.check(Some(item))));
        }
        if let Some(id @ (Value::String(_) | Value::Number(_))) = item.get("id")
            && !ids.insert(js::to_string(Some(id)))
        {
            problems.push(ViewProblem::new(
                format!("{path}.id"),
                format!("{} repeats an earlier id in {key} — ids must be unique", show(Some(id))),
            ));
        }
        if let Some(Value::String(image)) = item.get("image") {
            info.images.insert(image);
        }
        if let Some(Value::Array(images)) = item.get("images") {
            info.images.extend(images.iter().filter_map(Value::as_str));
        }
        if let Some(Value::String(site)) = item.get("site") {
            info.sites.insert(site.to_lowercase());
        }
        let refs: &[Value] = match item.get("source") {
            Some(n @ Value::Number(_)) => std::slice::from_ref(n),
            Some(Value::Array(list)) => list,
            _ => &[],
        };
        for n in refs.iter().filter_map(Value::as_f64) {
            if n.fract() == 0.0 && n.is_finite() && n >= 1.0 && n > info.sources_count as f64 {
                problems.push(ViewProblem::new(format!("{path}.source"), info.sources_hint(n)));
            }
        }
    }
    ids
}
