//! The prompt variables visual answers fill (`manager/modules/genui/prompt.ts`):
//! `GENUI_LEVEL` is the guidance line for the user's level, `GENUI_OFF` drops
//! the rest of the visual-answers fragments when the user wants text only.
//! Fixed at spawn like every prompt variable; the present routes enforce
//! "text" at call time for the sessions already running.

use eos_contracts::GenuiLevel;
use eos_prompts::genui_level::{self, render_genui_level};
use eos_runtime::module::PromptValue;

pub(crate) fn variables(level: GenuiLevel) -> Vec<(&'static str, PromptValue)> {
    let level = match level {
        GenuiLevel::Rich => genui_level::GenuiLevel::Rich,
        GenuiLevel::Balanced => genui_level::GenuiLevel::Balanced,
        GenuiLevel::Text => genui_level::GenuiLevel::Text,
    };
    vec![
        ("GENUI_LEVEL", PromptValue::Text(render_genui_level(level).to_owned())),
        ("GENUI_OFF", PromptValue::Flag(level == genui_level::GenuiLevel::Text)),
    ]
}
