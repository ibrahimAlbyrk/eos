//! Laying an accepted `config.json` over the defaults (`mergeConfig`).

use serde_json::{Map, Value, json};

/// Keys of one object written over another, as `Object.assign` does.
fn assign(target: &mut Value, source: &Map<String, Value>) {
    if let Value::Object(target) = target {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn is_tiered(price: &Value) -> bool {
    price.get("tiers").is_some_and(Value::is_array)
}

fn merge_prices(prices: &mut Value, incoming: &Map<String, Value>) {
    let Value::Object(prices) = prices else { return };
    for (model, inc) in incoming {
        if is_tiered(inc) {
            prices.insert(model.clone(), inc.clone());
            continue;
        }
        // A flat override names only the rates it changes; over a tiered or
        // unknown price it starts from zero.
        let mut merged = match prices.get(model) {
            Some(base) if !is_tiered(base) => base.clone(),
            _ => json!({ "in": 0, "out": 0, "cacheRead": 0, "cacheCreate": 0, "cacheCreate1h": 0 }),
        };
        if let Value::Object(inc) = inc {
            assign(&mut merged, inc);
        }
        prices.insert(model.clone(), merged);
    }
}

/// Entries of a record merged key by key: an entry in `incoming` overrides
/// the fields it names of the same entry in `target`, or starts a new one.
fn merge_entries(target: &mut Value, incoming: &Map<String, Value>) {
    let Value::Object(target) = target else { return };
    for (id, inc) in incoming {
        let entry = target.entry(id.clone()).or_insert_with(|| json!({}));
        if let Value::Object(inc) = inc {
            assign(entry, inc);
        }
    }
}

/// Section by section. Only the model's own sections are merged, and only
/// from an object: anything else in the file is left out.
pub(super) fn merge(mut base: Value, accepted: &Value) -> Value {
    let (Value::Object(sections), Value::Object(file)) = (&mut base, accepted) else { return base };
    for (key, section) in sections.iter_mut() {
        let Some(Value::Object(incoming)) = file.get(key) else { continue };
        match key.as_str() {
            "prices" => merge_prices(section, incoming),
            "mcp" => {
                for role in ["orchestrator", "worker"] {
                    if let (Some(target), Some(Value::Object(inc))) = (section.get_mut(role), incoming.get(role)) {
                        assign(target, inc);
                    }
                }
            }
            "memory" => {
                if let Some(enabled @ Value::Bool(_)) = incoming.get("enabled") {
                    section["enabled"] = enabled.clone();
                }
                if let Some(Value::Object(sources)) = incoming.get("sources") {
                    merge_entries(&mut section["sources"], sources);
                }
            }
            "backends" => assign(section, incoming),
            "defaults" => {
                for role in ["orchestrator", "worker"] {
                    match incoming.get(role).and_then(|r| r.get("backend")).and_then(Value::as_str) {
                        Some(backend) if !backend.is_empty() => section[role] = json!({ "backend": backend }),
                        _ => {}
                    }
                }
            }
            "loop" => {
                let mut rest = incoming.clone();
                let judge = rest.remove("judge");
                assign(section, &rest);
                if let Some(Value::Object(judge)) = judge {
                    assign(&mut section["judge"], &judge);
                }
            }
            "microTasks" => {
                if let Some(enabled @ Value::Bool(_)) = incoming.get("enabled") {
                    section["enabled"] = enabled.clone();
                }
                if let Some(pause @ Value::Number(_)) = incoming.get("pauseMaxMs") {
                    section["pauseMaxMs"] = pause.clone();
                }
                if let Some(Value::Object(tasks)) = incoming.get("tasks") {
                    merge_entries(&mut section["tasks"], tasks);
                }
            }
            _ => assign(section, incoming),
        }
    }
    base
}
