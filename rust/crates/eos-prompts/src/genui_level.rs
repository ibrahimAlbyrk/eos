//! How readily a session answers with a view: the user's `genui.level`
//! setting as prompt text (`core/src/services/render-genui-level.ts`,
//! `manager/modules/genui/prompt.ts`). Fixed at spawn like every variable.

use serde_json::Value;

use crate::template::VariableScope;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenuiLevel {
    Rich,
    Balanced,
    Text,
}

/// The stored setting; anything unknown (or nothing) is `balanced`.
pub fn normalize_genui_level(level: Option<&str>) -> GenuiLevel {
    match level {
        Some("rich") => GenuiLevel::Rich,
        Some("text") => GenuiLevel::Text,
        _ => GenuiLevel::Balanced,
    }
}

/// `GENUI_LEVEL`: one line of guidance.
pub fn render_genui_level(level: GenuiLevel) -> &'static str {
    match level {
        GenuiLevel::Rich => {
            "The user set visual answers to **rich**: present whenever the answer has structure — options, a list, steps, numbers — even a small one. A one-line answer, code and reasoning stay text."
        }
        GenuiLevel::Balanced => {
            "The user set visual answers to **balanced**: present when a view clearly beats prose (the cases below); otherwise answer in text."
        }
        GenuiLevel::Text => {
            "The user turned visual answers **off**: answer in text and markdown, never with a view or an app."
        }
    }
}

/// The variables visual answers fill for a session: `GENUI_LEVEL`, and
/// `GENUI_OFF` when the user wants text only.
pub fn genui_prompt_variables(level: Option<&str>) -> VariableScope {
    let level = normalize_genui_level(level);
    let mut vars = VariableScope::new();
    vars.insert("GENUI_LEVEL".to_owned(), Value::String(render_genui_level(level).to_owned()));
    vars.insert("GENUI_OFF".to_owned(), Value::Bool(level == GenuiLevel::Text));
    vars
}
