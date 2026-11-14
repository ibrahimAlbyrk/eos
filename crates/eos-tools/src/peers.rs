//! Workers of one orchestrator consulting each other (`list_peers`,
//! `ask_peer`, `respond_to_peer`): only a worker started to collaborate has them.

use std::sync::Arc;

use eos_contracts::PeerRef;
use eos_core::BoxFuture;
use eos_core::agent::{PeerConsult, Peers};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::schema::{object, string};
use crate::tool::{Call, Handler, Outcome, Output, Spec, args};

struct ListPeers(Arc<dyn Peers>);

impl Handler for ListPeers {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let peers = self.0.list(call.self_id).await?;
            // An empty list is not "you are alone": peers may still be starting.
            if peers.is_empty() {
                return Ok(Output::text(
                    "No peers have registered yet — but you ARE in a collaboration group, so your provider peers may still be spawning (they can arrive after you). If you know a peer's name (the orchestrator names your specialists in your directive), call ask_peer with that peerName now — it will block until that peer joins and then answers. Otherwise re-check shortly.",
                ));
            }
            Ok(Output::json(&peers))
        })
    }
}

struct AskPeer(Arc<dyn Peers>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskArgs {
    peer_id: Option<String>,
    peer_name: Option<String>,
    question: String,
}

impl Handler for AskPeer {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let AskArgs { peer_id, peer_name, question } = args(input)?;
            let target = match (peer_id, peer_name) {
                (Some(id), _) => PeerRef { id: Some(id), name: None },
                (None, Some(name)) => PeerRef { id: None, name: Some(name) },
                (None, None) => {
                    return Ok(Output::text(
                        "Pass either peerId (from list_peers) or peerName (the name the orchestrator gave the peer). Nothing was sent.",
                    ));
                }
            };
            // Waits as long as the peer works on its answer.
            Ok(Output::Text(match self.0.ask(call.self_id, target, question).await? {
                PeerConsult::Answered(answer) => answer,
                PeerConsult::NotSent { reason } => reason
                    .unwrap_or_else(|| "The peer could not be consulted. Proceed on your best judgment.".to_owned()),
                PeerConsult::Declined { reason } => format!(
                    "The peer did not answer: {}. Proceed on your best judgment, or — if you are truly blocked without it — finish with a 'needs input:'/'failed:' report explaining what you needed.",
                    reason.as_deref().unwrap_or("no reason given")
                ),
                PeerConsult::Gone => "The peer you consulted is no longer available — it was stopped, crashed, or exited before answering, so no answer will come. Proceed without its input if you can, or finish with a 'needs input:'/'failed:' report saying you were blocked on it.".to_owned(),
            }))
        })
    }
}

struct RespondToPeer(Arc<dyn Peers>);

#[derive(Deserialize)]
struct RespondArgs {
    answer: String,
}

impl Handler for RespondToPeer {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let RespondArgs { answer } = args(input)?;
            let Some(to) = self.0.respond(call.self_id, answer).await? else {
                return Ok(Output::text(
                    "No peer request was waiting on you (it may have been withdrawn or already answered). Nothing was delivered.",
                ));
            };
            // On one line: the chat labels the call with the asker's name.
            Ok(Output::Text(json!({"delivered": true, "toWorker": to.to_worker, "toName": to.to_name}).to_string()))
        })
    }
}

pub(crate) fn specs(peers: &Arc<dyn Peers>) -> Vec<Spec> {
    vec![
        Spec::new("list_peers", object(vec![]), ListPeers(peers.clone())),
        Spec::new(
            "ask_peer",
            object(vec![
                (
                    "peerId",
                    string()
                        .optional()
                        .describe("The id of the peer to consult (from list_peers) — for a peer you can already see."),
                ),
                (
                    "peerName",
                    string().optional().describe(
                        "The name of the peer to consult (the slug the orchestrator gave it, e.g. 'auth-expert'). Use this when the peer may not have spawned yet — the consult waits until a peer with this name joins. Pass peerId OR peerName, not both.",
                    ),
                ),
                (
                    "question",
                    string().describe(
                        "One focused, self-contained question, with the context the peer needs to answer.",
                    ),
                ),
            ]),
            AskPeer(peers.clone()),
        ),
        Spec::new(
            "respond_to_peer",
            object(vec![(
                "answer",
                string().describe("Your complete, self-contained answer to the peer request delivered this turn."),
            )]),
            RespondToPeer(peers.clone()),
        ),
    ]
}
