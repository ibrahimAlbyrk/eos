//! Prompts.
//!
//! Two layers, as in the TypeScript (`core/src/services`, `core/src/use-cases/AssembleSystemPrompt.ts`):
//!
//! 1. **Templates.** A prompt is a markdown file with frontmatter; its body
//!    is a template in a tiny language ([`template`]): `{{NAME}}`,
//!    `{{#if NAME}}…{{/if}}`, `{{#unless NAME}}…{{/unless}}`. The
//!    [`PromptRegistry`] holds the parsed library, the [`PromptService`]
//!    renders one prompt with its variables.
//! 2. **The system prompt.** A prompt whose frontmatter has a `dpi` block is a
//!    fragment. [`assemble_system_prompt`] picks the fragments whose `when`
//!    holds for a session's facts ([`select`], [`condition`]), orders them,
//!    renders each and joins them. A `when` may only look at facts that never
//!    change during a session (`role`, `isSubagent`, `isWorktree`,
//!    `workerDefinition`, `plugin-off:<id>`, …): the prompt is fixed at start.
//!
//! Around them: the tool-name variables every prompt may use ([`tool_names`]),
//! the tool descriptions ([`tool_descriptions`]), the provider's tier and
//! effort texts ([`tiers`]), the visual-answer level ([`genui_level`]), the
//! one-shot prompts ([`templates`]: compaction, dreaming, auto-name), memory
//! folded behind the prompt ([`memory`]), a spawn's own prompt ([`spawn`]) and
//! the offline [`preview`].

pub mod assemble;
pub mod condition;
pub mod genui_level;
pub mod memory;
pub mod preview;
pub mod prompt;
pub mod registry;
pub mod select;
pub mod service;
pub mod spawn;
pub mod template;
pub mod templates;
pub mod tiers;
pub mod tool_descriptions;
pub mod tool_names;

pub use assemble::{AssembleResult, DEFAULT_USER_PREFERENCES, SessionSpawnContext, assemble_system_prompt};
pub use prompt::{Fragment, ParsedPrompt, definition_fragment, parse_prompt, to_fragment};
pub use registry::PromptRegistry;
pub use service::PromptService;
pub use template::VariableScope;
