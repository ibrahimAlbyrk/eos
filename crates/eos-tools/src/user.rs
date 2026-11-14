//! An orchestrator reaching the user (`notify_user`, `ask_user`).

use std::sync::Arc;

use eos_contracts::{NotifyRequest, UnknownRecord};
use eos_core::BoxFuture;
use eos_core::agent::{UserNotifier, UserQuestions};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::schema::{array, boolean, object, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

struct NotifyUser(Arc<dyn UserNotifier>);

impl Handler for NotifyUser {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let note: NotifyRequest = eos_contracts::parse(&input)
                .map_err(|e| Failure::refused(eos_contracts::ValidationError::STATUS, &e.message()))?;
            self.0.notify(call.self_id, &note.title, &note.body);
            Ok(Output::json(&json!({"ok": true})))
        })
    }
}

struct AskUser(Arc<dyn UserQuestions>);

#[derive(Deserialize)]
struct AskArgs {
    questions: Vec<UnknownRecord>,
}

impl Handler for AskUser {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let AskArgs { questions } = args(input)?;
            // The call waits as long as the user takes: there is no time limit.
            Ok(match self.0.ask(call.self_id, None, questions).await {
                Some(answers) => Output::json(&json!({ "answers": answers })),
                None => Output::text(
                    "The user dismissed the question without answering. Proceed on your best judgment; if you stay blocked, say so in chat and notify_user.",
                ),
            })
        })
    }
}

pub(crate) fn notify_user(notifier: &Arc<dyn UserNotifier>) -> Spec {
    Spec::new(
        "notify_user",
        object(vec![
            ("title", string().describe("Short headline, a few words. E.g. 'Task complete'")),
            (
                "body",
                string().describe(
                    "One sentence with the concrete outcome. E.g. 'Auth refactor done across 3 workers — review ready.'",
                ),
            ),
        ]),
        NotifyUser(notifier.clone()),
    )
}

pub(crate) fn ask_user(questions: &Arc<dyn UserQuestions>) -> Spec {
    let option = object(vec![
        ("label", string().describe("Concise choice text (1-5 words).")),
        ("description", string().optional().describe("What this choice means / its trade-off.")),
    ]);
    let question = object(vec![
        ("question", string().describe("The complete question, ending with a question mark.")),
        ("header", string().optional().describe("Short chip label, max ~12 chars. E.g. 'Approach'.")),
        ("multiSelect", boolean().optional().describe("Allow picking several options.")),
        (
            "options",
            array(option)
                .min(2)
                .max(4)
                .describe("2-4 distinct choices. The dashboard adds a free-text 'Other' automatically."),
        ),
    ]);
    Spec::new(
        "ask_user",
        object(vec![(
            "questions",
            array(question).min(1).max(4).describe("1-4 questions, shown to the operator as one banner."),
        )]),
        AskUser(questions.clone()),
    )
}
