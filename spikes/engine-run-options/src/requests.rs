//! Reading the requests the mock received: their text, tools and tool
//! results, and printing what one of them sent to the model.

use serde_json::Value;

/// The system prompt's text.
pub fn system_of(body: &Value) -> String {
    body["system"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect()
}

/// Every string in the request's messages, one per line.
pub fn text_of(body: &Value) -> String {
    fn walk(value: &Value, out: &mut String) {
        match value {
            Value::String(s) => {
                out.push_str(s);
                out.push('\n');
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            Value::Object(map) => map.values().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = String::new();
    walk(&body["messages"], &mut out);
    out
}

/// The names of the tools the request offers.
pub fn tools_of(body: &Value) -> Vec<String> {
    body["tools"].as_array().into_iter().flatten().filter_map(|t| t["name"].as_str().map(str::to_owned)).collect()
}

/// The full definition of the tool `name`, as sent.
pub fn tool_of(body: &Value, name: &str) -> Option<Value> {
    body["tools"].as_array()?.iter().find(|t| t["name"] == name).cloned()
}

/// The result of the tool call `id` in any request: its text and whether it
/// is an error.
pub fn tool_result(requests: &[Value], id: &str) -> Option<(String, bool)> {
    requests.iter().rev().find_map(|body| {
        body["messages"].as_array()?.iter().find_map(|m| {
            m["content"].as_array()?.iter().find(|b| b["type"] == "tool_result" && b["tool_use_id"] == id).map(|b| {
                let text = match &b["content"] {
                    Value::String(s) => s.clone(),
                    other => other.as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect(),
                };
                (text, b["is_error"] == true)
            })
        })
    })
}

/// Whether the last message of the request carries the result of call `id`.
pub fn answers(body: &Value, id: &str) -> bool {
    let last = body["messages"].as_array().and_then(|m| m.last()).cloned().unwrap_or_default();
    last["content"].as_array().into_iter().flatten().any(|b| b["type"] == "tool_result" && b["tool_use_id"] == id)
}

/// The first task notification that reached the model, if one did.
pub fn notification(requests: &[Value]) -> Option<String> {
    requests.iter().map(text_of).find_map(|text| {
        let start = text.find("<task-notification>")?;
        let end = text[start..].find("</task-notification>").map_or(text.len(), |e| start + e + 20);
        Some(text[start..end].to_owned())
    })
}

/// A request from an agent a workflow script started.
pub fn from_workflow_agent(body: &Value) -> bool {
    system_of(body).contains("spawned by a workflow orchestration script")
}

/// Prints what `body` sent to the model: its tools and its messages.
pub fn show(label: &str, body: &Value) {
    println!("===== {label}: what was sent to the model =====");
    println!("tools: {}", tools_of(body).join(", "));
    println!("----- messages -----");
    println!("{}", text_of(body).trim_end());
    println!("===== end of {label} =====\n");
}
