//! The one-shot prompts of the library, by what they are for: each is a
//! library prompt rendered with the values it declares.

use eos_core::Error;
use serde_json::Value;

use crate::service::{PromptService, no_values};
use crate::template::VariableScope;

fn values(pairs: &[(&str, &str)]) -> VariableScope {
    pairs.iter().map(|(name, value)| ((*name).to_owned(), Value::String((*value).to_owned()))).collect()
}

fn render(prompts: &PromptService, id: &str, pairs: &[(&str, &str)]) -> Result<String, Error> {
    prompts.render(id, &values(pairs), &no_values())
}

/// Context compaction.
pub mod compaction {
    use super::{Error, PromptService, render};

    /// The summarizer's system prompt.
    pub fn summarizer_system(prompts: &PromptService) -> Result<String, Error> {
        render(prompts, "compaction/summarizer-system", &[])
    }

    /// The request: the rendered transcript, and what the user typed after `/compact`.
    pub fn summarize(prompts: &PromptService, transcript: &str, instructions: Option<&str>) -> Result<String, Error> {
        let pairs = [("TRANSCRIPT", transcript), ("INSTRUCTIONS", instructions.unwrap_or_default())];
        render(prompts, "compaction/summarize", &pairs)
    }

    /// What the session that replaces the compacted one starts from.
    pub fn continuation(
        prompts: &PromptService,
        summary: &str,
        transcript_path: Option<&str>,
    ) -> Result<String, Error> {
        let pairs = [("SUMMARY", summary), ("TRANSCRIPT_PATH", transcript_path.unwrap_or_default())];
        render(prompts, "compaction/continuation", &pairs)
    }
}

/// Dreaming's four calls.
pub mod dream {
    use super::{Error, PromptService, render};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Step {
        Recall,
        Match,
        Consolidate,
        Critic,
    }

    impl Step {
        pub fn name(self) -> &'static str {
            match self {
                Step::Recall => "recall",
                Step::Match => "match",
                Step::Consolidate => "consolidate",
                Step::Critic => "critic",
            }
        }
    }

    /// The system prompt and the request of one step. `vars` are the values
    /// the step's request declares (`CHAT`, `PROJECT`, `TRANSCRIPT` for recall;
    /// `SIGNALS`, `CANDIDATES`, `MEMORIES` for match; `CANDIDATES`,
    /// `MEMORIES`, `PROFILE` for consolidate; `PROPOSALS`, `MEMORIES`,
    /// `PROFILE` for the critic).
    pub fn step(prompts: &PromptService, step: Step, vars: &[(&str, &str)]) -> Result<(String, String), Error> {
        let system = render(prompts, &format!("dream/{}-system", step.name()), &[])?;
        let request = render(prompts, &format!("dream/{}", step.name()), vars)?;
        Ok((system, request))
    }
}

/// Micro-tasks.
pub mod micro_task {
    use super::{Error, PromptService, no_values, values};
    use crate::template::js_trim;

    /// The request of a micro-task: the library prompt `prompt_id`, or the
    /// user's own template for the task when the settings carry one. Trimmed.
    pub fn request(
        prompts: &PromptService,
        prompt_id: &str,
        override_template: Option<&str>,
        vars: &[(&str, &str)],
    ) -> Result<String, Error> {
        let locals = values(vars);
        let text = match override_template.filter(|template| !template.is_empty()) {
            Some(template) => prompts.render_inline(template, &locals, &no_values())?,
            None => prompts.render(prompt_id, &locals, &no_values())?,
        };
        Ok(js_trim(&text).to_owned())
    }

    /// Naming a fresh chat from its first request.
    pub fn auto_name(
        prompts: &PromptService,
        override_template: Option<&str>,
        user_input: &str,
    ) -> Result<String, Error> {
        request(prompts, "micro-tasks/auto-name", override_template, &[("USER_INPUT", user_input)])
    }
}
