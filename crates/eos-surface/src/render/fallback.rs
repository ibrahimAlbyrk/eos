//! The View Eos builds with no agent when a page cannot be filled (three
//! refused fills, a run that ends without one, no kept design) and when the
//! reader asks for plain reading: one Section per top-level field holding a
//! List, a row per item of a list, per text of an object (its field's name
//! as the meta) or for the one value. Values stay in the View's data, read
//! by a List row's slots, so no text of the issue is ever markup: a Text's
//! children are markdown, never filled from data. Images are left out: a
//! View fetches its images when it is read, and a surface never does.

use serde_json::{Map, Value, json};

use crate::types::Contract;

/// Longest text kept of one value.
const TEXT_CHARS: usize = 2_000;
const LIST_ITEMS: usize = 30;

/// The fallback View for `data`, with the field names the contract gives
/// (every top-level name of the data when there is no contract).
pub fn fallback_view(title: &str, contract: Option<&Contract>, data: &Value) -> Value {
    let names: Vec<String> = match contract {
        Some(contract) => contract.fields.iter().map(|f| f.name.clone()).collect(),
        None => data.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default(),
    };
    let mut ui = String::new();
    let mut view_data = Map::new();
    let mut summary = None;
    for name in names {
        let Some(value) = data.get(&name).filter(|v| !v.is_null()) else { continue };
        let key = format!("f{}", view_data.len());
        let label = label(&name);
        match value {
            Value::Array(items) => {
                let rows: Vec<Value> =
                    items.iter().take(LIST_ITEMS).enumerate().map(|(i, item)| row(i, item)).collect();
                if rows.is_empty() {
                    continue;
                }
                ui.push_str(&list(&label, &key));
                view_data.insert(key, Value::Array(rows));
            }
            Value::Object(fields) => {
                let rows: Vec<Value> = fields
                    .iter()
                    .filter_map(|(k, v)| text(v).map(|t| (self::label(k), t)))
                    .enumerate()
                    .map(|(i, (name, t))| json!({"id": i, "title": t, "meta": name}))
                    .collect();
                let Some(first) = rows.first() else { continue };
                summary = summary.or_else(|| first["title"].as_str().map(str::to_owned));
                ui.push_str(&list(&label, &key));
                view_data.insert(key, Value::Array(rows));
            }
            scalar => {
                let Some(t) = text(scalar) else { continue };
                summary = summary.or_else(|| Some(t.clone()));
                ui.push_str(&list(&label, &key));
                view_data.insert(key, json!([{"id": 0, "title": t, "meta": ""}]));
            }
        }
    }
    if ui.is_empty() {
        ui.push_str("<Text>This issue holds nothing to show.</Text>");
    }
    json!({
        "title": title,
        "summary": summary.map(|s| s.chars().take(200).collect::<String>()).unwrap_or_else(|| "Shown plainly.".into()),
        "ui": ui,
        "data": view_data,
    })
}

/// A Section of `label` holding the List of the rows at `key`.
fn list(label: &str, key: &str) -> String {
    format!("<Section title=\"{label}\"><List of=\"{key}\" title=\"{{title}}\" meta=\"{{meta}}\"/></Section>\n")
}

fn row(i: usize, item: &Value) -> Value {
    let texts: Vec<String> = match item {
        Value::Object(fields) => fields.values().filter_map(text).collect(),
        other => text(other).into_iter().collect(),
    };
    let mut texts = texts.into_iter();
    json!({"id": i, "title": texts.next().unwrap_or_default(), "meta": texts.next().unwrap_or_default()})
}

fn text(value: &Value) -> Option<String> {
    let t = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Object(o) => o.get("alt").and_then(Value::as_str)?.to_owned(),
        _ => return None,
    };
    let t = t.trim();
    (!t.is_empty()).then(|| t.chars().take(TEXT_CHARS).collect())
}

/// `left_out` reads as "Left out".
fn label(name: &str) -> String {
    // A key of data with no contract is outside text: it keeps only letters
    // and digits, as it sits in the View's markup.
    let words: String = name.chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_genui::{ViewValidation, validate_view};

    #[test]
    fn a_fallback_view_passes_the_view_checks_and_keeps_text_out_of_its_markup() {
        let data = json!({
            "title": "<Section>{secret}</Section>",
            "lead": {"title": "A lead", "url": "https://example.com", "image": {"src": "https://x/y.png", "alt": "A picture"}},
            "stories": [{"title": "One", "dek": "First"}, {"title": "Two"}],
            "empty": [],
            "n": 3
        });
        let view = fallback_view("Morning Paper", None, &data);
        let genui: eos_genui::Value = serde_json::from_value(view.clone()).expect("a view");
        if let ViewValidation::Rejected { problems, .. } = validate_view(&genui) {
            panic!("{}\n{view}", eos_genui::format_problems(&problems));
        }
        let ui = view["ui"].as_str().expect("ui");
        assert!(!ui.contains("secret") && !ui.contains("A lead"), "{ui}");
        assert_eq!(view["data"]["f0"][0]["title"], "<Section>{secret}</Section>");
        assert_eq!(view["data"]["f1"][0], json!({"id": 0, "title": "A lead", "meta": "Title"}));
        assert!(!ui.contains("<Text>{"), "a Text's children are never filled from data: {ui}");
        assert!(!ui.contains("<Image"));
    }
}
