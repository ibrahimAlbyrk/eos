//! The View Eos builds with no agent when a page cannot be filled (three
//! refused fills, a run that ends without one, no kept design) and when the
//! reader asks for plain reading: one Section per top-level field, a List
//! per list, a Text per value. Values stay in the View's data, read by
//! slot, so no text of the issue is ever markup. Images are left out: a
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
                ui.push_str(&format!(
                    "<Section title=\"{label}\"><List of=\"{key}\" title=\"{{title}}\" meta=\"{{meta}}\"/></Section>\n"
                ));
                view_data.insert(key, Value::Array(rows));
            }
            Value::Object(fields) => {
                let texts: Map<String, Value> =
                    fields.iter().filter_map(|(k, v)| text(v).map(|t| (safe_key(k), Value::String(t)))).collect();
                if texts.is_empty() {
                    continue;
                }
                summary = summary.or_else(|| texts.values().next().and_then(Value::as_str).map(str::to_owned));
                ui.push_str(&format!("<Section title=\"{label}\">"));
                for k in texts.keys() {
                    ui.push_str(&format!("<Text>{{{key}.{k}}}</Text>"));
                }
                ui.push_str("</Section>\n");
                view_data.insert(key, Value::Object(texts));
            }
            scalar => {
                let Some(t) = text(scalar) else { continue };
                summary = summary.or_else(|| Some(t.clone()));
                ui.push_str(&format!("<Section title=\"{label}\"><Text>{{{key}}}</Text></Section>\n"));
                view_data.insert(key, Value::String(t));
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

/// A data key the View's slots can name.
fn safe_key(name: &str) -> String {
    let key: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    if key.starts_with(|c: char| c.is_ascii_alphabetic()) { key } else { format!("k{key}") }
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
        assert_eq!(view["data"]["f0"], "<Section>{secret}</Section>");
        assert!(!ui.contains("<Image"));
    }
}
