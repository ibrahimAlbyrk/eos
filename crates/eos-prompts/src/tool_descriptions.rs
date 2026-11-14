//! Tool descriptions: each is the prompt `tool/<name>`, rendered once with the
//! tool names and — for `present` — the visual-answer catalog, which is
//! generated from the validator's own tables so the reference cannot drift from
//! what it accepts.

use std::sync::Arc;

use serde_json::Value;

use crate::registry::PromptRegistry;
use crate::service::{PromptService, no_values};
use crate::tool_names::tool_name_vars;

/// The description of each named tool, in the order asked. A tool whose
/// prompt is missing or broken is described by its bare name: degraded, but
/// it still works.
pub fn render_tool_descriptions(registry: Arc<PromptRegistry>, names: &[&str]) -> Vec<(String, String)> {
    let mut globals = tool_name_vars();
    globals.insert("GENUI_CATALOG".to_owned(), Value::String(eos_genui::catalog_prompt()));
    let prompts = PromptService::new(registry, globals);
    names
        .iter()
        .map(|name| {
            let description = match prompts.render(&format!("tool/{name}"), &no_values(), &no_values()) {
                Ok(text) => crate::template::js_trim(&text).to_owned(),
                Err(e) => {
                    tracing::warn!(tool = name, error = %e, "tool description unavailable");
                    (*name).to_owned()
                }
            };
            ((*name).to_owned(), description)
        })
        .collect()
}
