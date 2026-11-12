//! A focused session's question tool, answered by the user through Eos.

use std::sync::Arc;

use eos_agent_core::BoxFuture;
use eos_agent_tools_session::{Question, Refusal, Reply, UserPrompter};
use eos_contracts::UnknownRecord;
use eos_core::agent::UserQuestions;
use serde_json::Value;

use crate::registry::Registry;

pub(crate) struct Prompter {
    pub(crate) questions: Arc<dyn UserQuestions>,
    pub(crate) sessions: Arc<Registry>,
}

impl std::fmt::Debug for Prompter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Prompter")
    }
}

const DISMISSED: &str = "The user dismissed the question without answering. Proceed on your best judgment.";

impl UserPrompter for Prompter {
    fn ask<'a>(
        &'a self,
        agent_id: &'a str,
        tool_use_id: &'a str,
        questions: &'a [Question],
    ) -> BoxFuture<'a, Result<Reply, Refusal>> {
        Box::pin(async move {
            // Only a session's own agent talks to the user; a subagent reports to its parent.
            if !self.sessions.is_live(agent_id) {
                return Err(Refusal::Unanswered("Only the main agent can ask the user. Report back instead.".into()));
            }
            let asked: Vec<UnknownRecord> = questions
                .iter()
                .filter_map(|q| serde_json::to_value(q).ok())
                .filter_map(|v| serde_json::from_value(v).ok())
                .collect();
            let Some(answers) = self.questions.ask(agent_id, Some(tool_use_id), asked).await else {
                return Err(Refusal::Unanswered(DISMISSED.into()));
            };
            let answers = answers
                .into_iter()
                .map(|(question, answer)| {
                    let answer = match answer {
                        Value::String(text) => text,
                        other => other.to_string(),
                    };
                    (question, answer)
                })
                .collect();
            Ok(Reply { answers, ..Reply::default() })
        })
    }
}
