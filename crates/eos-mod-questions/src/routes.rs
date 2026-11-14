//! The question routes.

use eos_contracts::{QuestionAnswerRequest, QuestionRegisterResponse, QuestionRequest};
use eos_runtime::access::{Access, Tier};
use eos_runtime::http::{Request, Response};
use eos_runtime::router::RouteDef;
use serde_json::json;

use crate::Questions;

fn worker_id(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

pub(crate) fn all(questions: &Questions) -> Vec<RouteDef> {
    let q = questions.clone();
    // For an asker outside the app: it gets an id at once and polls.
    let register = RouteDef::post("/workers/{id}/question", move |req: Request| {
        let q = q.clone();
        async move {
            let body: QuestionRequest = req.parse()?;
            let opened = q.register(&worker_id(&req), body.tool_use_id.flatten(), body.questions).await?;
            let answer = QuestionRegisterResponse { question_id: opened.question_id, tool_use_id: opened.tool_use_id };
            Ok(Response::json(200, &answer))
        }
    })
    .access(Access::open().local_only());

    let q = questions.clone();
    let poll = RouteDef::get("/workers/{id}/question/{questionId}", move |req: Request| {
        let q = q.clone();
        async move { Ok(Response::json(200, &q.poll(req.param("questionId").unwrap_or_default()))) }
    })
    .access(Access::open().local_only());

    let q = questions.clone();
    let answer = RouteDef::post("/workers/{id}/question-answer", move |req: Request| {
        let q = q.clone();
        async move {
            let body: QuestionAnswerRequest = req.parse()?;
            let answers = (body.dismissed != Some(true)).then(|| body.answers.unwrap_or_default());
            let outcome = q.answer(&worker_id(&req), &body.tool_use_id, answers).await?;
            Ok(Response::json(200, &json!({"ok": true, "outcome": outcome.as_str()})))
        }
    })
    .access(Access::open().phone(Tier::Low));

    vec![register, poll, answer]
}
