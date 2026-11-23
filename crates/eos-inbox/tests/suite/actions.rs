//! The gate of a surface's direct actions: reads, local writes and telling
//! the user run; speaking for the user waits as a draft; what cannot be
//! taken back asks for a typed confirmation; nothing runs while Eos is
//! stopped.

use eos_contracts::ActionClass;
use eos_core::inbox::{ActionDecision, ActionGate, ActionRequest};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_inbox::gate::{ActionGateParts, DirectActionGate};
use serde_json::json;

use crate::rig::Rig;

fn gate(rig: &Rig) -> DirectActionGate {
    DirectActionGate::new(ActionGateParts {
        store: rig.temp.port(),
        clock: rig.clock.clone(),
        ids: rig.ids.clone(),
        zone: rig.zone.clone(),
        control: rig.control.clone(),
    })
}

fn request(class: ActionClass) -> ActionRequest {
    ActionRequest {
        routine_id: "rt-1".into(),
        class,
        action_id: "cap.mail.send_mail".into(),
        title: "Send the reply".into(),
        args: json!({"subject": "Re: invoice"}),
        origin: "dashboard".into(),
    }
}

#[tokio::test]
async fn what_stays_on_this_computer_runs_and_what_cannot_be_undone_asks() {
    let rig = Rig::new();
    let gate = gate(&rig);
    for class in [ActionClass::Read, ActionClass::WriteLocal, ActionClass::TellUser] {
        assert_eq!(gate.decide(&request(class)).await.expect("decided"), ActionDecision::Run, "{class:?}");
    }
    let ActionDecision::Confirm { prompt } = gate.decide(&request(ActionClass::Irreversible)).await.expect("decided")
    else {
        panic!("asks first")
    };
    assert!(prompt.starts_with("Send the reply cannot be taken back"), "{prompt}");
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM inbox_items"), 0, "no item for any of them");
}

#[tokio::test]
async fn speaking_for_the_user_waits_as_a_draft_with_its_arguments() {
    let rig = Rig::new();
    let decision = gate(&rig).decide(&request(ActionClass::Speak)).await.expect("decided");
    let ActionDecision::Hold { item_id } = decision else { panic!("held: {decision:?}") };
    let item = rig.find(&item_id).await;
    assert_eq!((item.kind, item.state, item.routine_id.as_deref()), (ItemKind::Draft, ItemState::Open, Some("rt-1")));
    assert_eq!(item.title, "Send the reply");
    let payload: serde_json::Value = serde_json::from_str(&item.payload).expect("json");
    assert_eq!(
        payload["action"],
        json!({"id": "cap.mail.send_mail", "args": {"subject": "Re: invoice"}, "origin": "dashboard"})
    );
    assert_eq!(payload["targets"], json!([]), "a held action goes nowhere by itself");
}

#[tokio::test]
async fn nothing_runs_while_eos_is_stopped() {
    let rig = Rig::new();
    rig.items.halt("dashboard").await.expect("halted");
    let gate = gate(&rig);
    for class in [ActionClass::Read, ActionClass::Speak] {
        let decision = gate.decide(&request(class)).await.expect("decided");
        assert_eq!(decision, ActionDecision::Refuse { reason: "Eos is stopped".into() });
    }
    assert_eq!(rig.temp.count("SELECT COUNT(*) FROM inbox_items"), 0);
}
