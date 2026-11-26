//! A run agent's action that reaches past this computer (D73): it passes
//! the run's gate before anything runs, and the agent reads where it went
//! as an answer, not an error; a refusal reads the gate's words. A chat's
//! call never meets the gate. The `action:` channel sends what the gate
//! let go with the input the user saw, and takes it back by the action's
//! `undo`.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use eos_contracts::ActionClass;
use eos_core::BoxFuture;
use eos_core::capability::{
    ActionError, CapabilityCalls, CapabilityGrants, Grant, GrantedAction, RunAction, RunActionDecision,
};
use eos_core::delivery::{Place, SendRequest, Target, Undo};
use eos_domain::result_doc::action_doc;
use eos_testkit::{FakeBuiltin, FakeCapabilitySecrets};
use serde_json::{Value, json};

use crate::rig::{Rig, Setup, agent_call, rig};

const CHAT: &str = r#"
id = "chat"
name = "Chat"
version = "1"
summary = "Messages."
form = "builtin"
works = "any_mac"

[[actions]]
name = "post_message"
summary = "Post a message."
class = "speak"
recipient = "input:/to"
undo = "delete_message"
input = { type = "object", required = ["to", "text"], properties = { to = { type = "string" }, text = { type = "string" } } }

[[actions]]
name = "delete_message"
summary = "Delete a message."
class = "speak"
recipient = "input:/conversation"
input = { type = "object", required = ["conversation", "ts"], properties = { conversation = { type = "string" }, ts = { type = "string" } } }

[[actions]]
name = "tell_me"
summary = "Message yourself."
class = "tell_user"
recipient = "user"
input = { type = "object", properties = { text = { type = "string" } } }
"#;

/// A run's grant of every action, and a gate that answers as scripted.
#[derive(Default)]
struct RunGate {
    decisions: Mutex<VecDeque<RunActionDecision>>,
    asked: Mutex<Vec<RunAction>>,
}

impl CapabilityGrants for RunGate {
    fn grant<'a>(&'a self, _worker_id: &'a str) -> BoxFuture<'a, Option<Grant>> {
        let actions = ["post_message", "delete_message", "tell_me"]
            .map(|action| GrantedAction { capability: "chat".into(), action: action.into() })
            .to_vec();
        Box::pin(std::future::ready(Some(Grant { actions, max_class: ActionClass::Irreversible })))
    }

    fn gate<'a>(&'a self, action: &'a RunAction) -> BoxFuture<'a, Result<RunActionDecision, eos_core::Error>> {
        self.asked.lock().expect("asked").push(action.clone());
        let next = self.decisions.lock().expect("decisions").pop_front().expect("a decision");
        Box::pin(std::future::ready(Ok(next)))
    }
}

async fn chat(grants: Arc<dyn CapabilityGrants>) -> (Rig, Arc<FakeBuiltin>) {
    let posted = json!({"conversation": "D1", "ts": "1.5", "permalink": "https://chat.example/p/1"});
    let builtin = Arc::new(
        FakeBuiltin::new(CHAT).answering("post_message", Ok(posted)).answering("delete_message", Ok(json!({}))),
    );
    let setup =
        Setup { builtins: vec![builtin.clone()], secrets: FakeCapabilitySecrets::new(), grants, ..Setup::default() };
    (rig(setup).await, builtin)
}

fn dm() -> Value {
    json!({"to": "U1", "text": "Your pull request needs a rebase."})
}

#[tokio::test]
async fn a_run_agents_send_passes_its_gate_and_reads_where_it_went() {
    let gate = Arc::new(RunGate::default());
    let (rig, builtin) = chat(gate.clone()).await;
    let script = [
        RunActionDecision::Held { item_id: "in-1".into() },
        RunActionDecision::Queued { delivery_id: "dl-1".into() },
        RunActionDecision::Refused { reason: "Eos is stopped.".into() },
        RunActionDecision::Run,
    ];
    gate.decisions.lock().expect("decisions").extend(script);

    let held = rig.service.call(agent_call("chat", "post_message", dm())).await.expect("an answer, not an error");
    assert_eq!((held.output["status"].as_str(), held.output["itemId"].as_str()), (Some("held"), Some("in-1")));
    let queued = rig.service.call(agent_call("chat", "post_message", dm())).await.expect("an answer");
    assert_eq!(queued.output["status"], "sending");
    let refused = rig.service.call(agent_call("chat", "post_message", dm())).await;
    assert_eq!(refused, Err(ActionError::Refused("Eos is stopped.".into())));
    assert_eq!(refused.expect_err("refused").to_string(), "Eos is stopped.");
    assert!(builtin.calls().is_empty(), "nothing went out from the call itself");

    rig.service.call(agent_call("chat", "tell_me", json!({"text": "Done."}))).await.expect("runs");
    assert_eq!(builtin.calls().len(), 1, "telling the user runs when the gate says so");

    let asked = gate.asked.lock().expect("asked").clone();
    assert_eq!(
        (asked[0].recipient.as_deref(), asked[0].to_user, asked[0].class, asked[0].worker_id.as_str()),
        (Some("U1"), false, ActionClass::Speak, "w-1")
    );
    assert_eq!((asked[3].recipient.as_deref(), asked[3].to_user), (None, true));
    let denied = "SELECT COUNT(*) FROM capability_calls WHERE outcome = 'denied' AND error_kind = 'refused'";
    assert_eq!(rig.temp.count(denied), 1);
}

#[tokio::test]
async fn a_chats_send_never_meets_a_runs_gate() {
    let (rig, builtin) = chat(Arc::new(eos_core::capability::AllInstalled)).await;
    rig.service.call(agent_call("chat", "post_message", dm())).await.expect("runs");
    assert_eq!(builtin.calls().len(), 1);
}

#[tokio::test]
async fn the_action_channel_sends_the_input_the_user_saw_and_takes_it_back_by_its_undo() {
    let (rig, builtin) = chat(Arc::new(eos_core::capability::AllInstalled)).await;
    let channels = rig.service.channels();
    let channel = channels.get("action:chat").expect("a channel");
    let traits = channel.traits("post_message").expect("traits");
    assert_eq!((traits.class, traits.undo), (ActionClass::Speak, Undo::Full));
    assert_eq!(channel.traits("tell_me").map(|traits| traits.undo), Some(Undo::None), "no undo declared");
    assert!(channel.traits("merge").is_none());

    let req = SendRequest {
        key: "dl-1".into(),
        run_id: "rn-1".into(),
        channel: "action:chat".into(),
        action: "post_message".into(),
        target: Target { recipient_id: "chat:U1".into(), place: Place::Address("U1".into()) },
        body: action_doc("chat", "post_message", &dm()),
    };
    let receipt = channel.send(&req).await.expect("sent");
    assert_eq!(receipt.url.as_deref(), Some("https://chat.example/p/1"));
    let calls = builtin.calls();
    assert_eq!((calls[0].action.as_str(), &calls[0].input), ("post_message", &dm()));
    assert_eq!(calls[0].idempotency_key.as_deref(), Some("dl-1"));

    channel.undo(&receipt).await.expect("taken back");
    let undo = &builtin.calls()[1];
    assert_eq!((undo.action.as_str(), &undo.input), ("delete_message", &json!({"conversation": "D1", "ts": "1.5"})));
    let by_delivery = "SELECT COUNT(*) FROM capability_calls WHERE caller_kind = 'delivery'";
    assert_eq!(rig.temp.count(by_delivery), 2, "the delivery calls, past any run's gate");
}
