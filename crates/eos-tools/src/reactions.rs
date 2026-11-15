//! The agent's side of emoji reactions (`react`, `no_reply`).

use std::sync::Arc;

use eos_core::BoxFuture;
use eos_core::agent::{AgentReactions, ReactTarget};
use serde::Deserialize;
use serde_json::Value;

use crate::schema::{int, object, string};
use crate::tool::{Call, Handler, Outcome, Output, Spec, args};

struct React(Arc<dyn AgentReactions>);

#[derive(Deserialize)]
struct ReactArgs {
    emoji: String,
    message_id: Option<i64>,
}

impl Handler for React {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ReactArgs { emoji, message_id } = args(input)?;
            let emoji = Some(emoji.trim()).filter(|e| !e.is_empty());
            let target = message_id.map_or(ReactTarget::Latest, ReactTarget::Message);
            let reacted = self.0.react(call.self_id, target, emoji).await?;
            let did = if emoji.is_some() { "Reacted to" } else { "Reaction taken back from" };
            Ok(Output::text(format!("{did} the user's message: \"{}\"", reacted.excerpt)))
        })
    }
}

struct NoReply;

impl Handler for NoReply {
    fn run<'a>(&'a self, _call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async { Ok(Output::EndTurn("Turn ended without a reply.".to_owned())) })
    }
}

/// Both are sent with every request: a reaction is answered at once, and a
/// search for the tool would be a step the user waits through.
pub(crate) fn specs(reactions: &Arc<dyn AgentReactions>) -> Vec<Spec> {
    let react = Spec::new(
        "react",
        object(vec![
            ("emoji", string().describe("One emoji, e.g. '👍'. Empty takes your reaction back.")),
            (
                "message_id",
                int().positive().optional().describe(
                    "The N of the <msg id=\"N\"/> the user's message came with. Omit ⇒ the user's latest message.",
                ),
            ),
        ]),
        React(reactions.clone()),
    );
    vec![react.always_load(), Spec::new("no_reply", object(vec![]), NoReply).always_load()]
}

#[cfg(test)]
mod tests {
    use eos_core::agent::ToolSets;
    use eos_testkit::FakeFeatures;
    use serde_json::json;

    use crate::tests::{bench, call};

    #[tokio::test]
    async fn an_agent_reacts_to_the_users_latest_message_or_one_it_names() {
        let quoted = || (200, json!({"excerpt": "thanks a lot"}));
        let bench =
            bench(FakeFeatures::new([quoted(), quoted(), (409, json!({"error": "this chat takes no reactions"}))]));
        let react = bench.tool("focused", "react");
        let reply = call(&react, "w-self0001", json!({"emoji": " ❤️ "})).await;
        assert_eq!((reply.text.as_str(), reply.is_error), ("Reacted to the user's message: \"thanks a lot\"", false));
        assert!(!reply.ends_turn, "a reaction alone does not end the turn");
        let taken = call(&react, "w-self0001", json!({"emoji": "", "message_id": 7})).await;
        assert_eq!(taken.text, "Reaction taken back from the user's message: \"thanks a lot\"");
        let refused = call(&react, "w-self0001", json!({"emoji": "👍"})).await;
        assert_eq!(
            (refused.text.as_str(), refused.is_error),
            (r#"daemon 409: {"error":"this chat takes no reactions"}"#, true)
        );
        assert_eq!(
            bench.features.calls(),
            [
                ("react".to_owned(), json!({"workerId": "w-self0001", "messageId": null, "emoji": "❤️"})),
                ("react".to_owned(), json!({"workerId": "w-self0001", "messageId": 7, "emoji": null})),
                ("react".to_owned(), json!({"workerId": "w-self0001", "messageId": null, "emoji": "👍"})),
            ]
        );
        assert!(call(&react, "w-self0001", json!({"emoji": "👍", "message_id": 0})).await.is_error, "ids start at 1");
    }

    #[tokio::test]
    async fn no_reply_ends_the_turn_and_both_tools_skip_tool_search() {
        let bench = bench(FakeFeatures::new([]));
        let quiet = bench.tool("orchestrator", "no_reply");
        let reply = call(&quiet, "o-self0001", json!({})).await;
        assert!(reply.ends_turn && !reply.is_error, "{reply:?}");
        for (kind, name) in [("focused", "react"), ("focused", "no_reply"), ("orchestrator", "react")] {
            assert!(!bench.tool(kind, name).definition().deferred, "{kind} {name}");
        }
        let worker: Vec<String> = bench
            .tools
            .for_session(&crate::tests::session_of("worker"))
            .iter()
            .map(|t| t.definition().name.clone())
            .collect();
        assert!(!worker.iter().any(|n| n.ends_with("__react") || n.ends_with("__no_reply")), "{worker:?}");
    }
}
