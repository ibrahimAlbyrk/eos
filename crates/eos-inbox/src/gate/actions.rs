//! The gate a surface's direct action passes (03 §4.9), before its handler
//! runs: reads, writes on this computer and telling the user run; an action
//! that speaks for the user is held as a draft in Needs you, so nothing a
//! frame presses sends by itself; one that cannot be taken back asks for
//! Eos's own typed confirmation first; nothing runs while Eos is stopped.

use std::sync::Arc;

use eos_contracts::{ActionClass, ResultDoc};
use eos_core::inbox::{ActionDecision, ActionGate, ActionRequest};
use eos_core::os::TimeZone;
use eos_core::routine::RoutineControl;
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_domain::inbox::ItemKind;
use serde_json::json;

use crate::items::{NewItem, Opening, open_in};

/// Who makes the drafts of held actions.
const PRODUCER: &str = "surfaces";

/// What the gate is built from.
pub struct ActionGateParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub zone: Arc<dyn TimeZone>,
    /// Pauses a routine with too many items waiting, as any item opened.
    pub control: Arc<dyn RoutineControl>,
}

impl std::fmt::Debug for ActionGateParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActionGateParts").finish_non_exhaustive()
    }
}

pub struct DirectActionGate {
    parts: Arc<ActionGateParts>,
}

impl std::fmt::Debug for DirectActionGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirectActionGate").finish_non_exhaustive()
    }
}

impl DirectActionGate {
    pub fn new(parts: ActionGateParts) -> Self {
        Self { parts: Arc::new(parts) }
    }
}

/// The draft a held action waits as: what it would do, with the arguments
/// the core typed, and no target of its own.
fn held_draft(request: &ActionRequest) -> NewItem {
    let doc = ResultDoc {
        kind: "action".into(),
        channel: String::new(),
        action: request.action_id.clone(),
        parts: Vec::new(),
    };
    NewItem {
        kind: ItemKind::Draft,
        producer: PRODUCER.into(),
        routine_id: Some(request.routine_id.clone()).filter(|id| !id.is_empty()),
        run_id: None,
        subject_key: None,
        title: request.title.clone(),
        summary: "Waits for you before it speaks for you".into(),
        payload: json!({
            "doc": doc,
            "targets": [],
            "action": {"id": request.action_id, "args": request.args, "origin": request.origin},
        }),
        by_hand: true,
    }
}

impl ActionGate for DirectActionGate {
    fn decide<'a>(&'a self, request: &'a ActionRequest) -> BoxFuture<'a, Result<ActionDecision, Error>> {
        let (parts, request) = (self.parts.clone(), request.clone());
        Box::pin(async move {
            let now = parts.clock.now_ms();
            let store = parts.store.clone();
            let decision = store
                .write(move |tx, out| {
                    if tx.inbox_halt().get()?.on {
                        return Ok(ActionDecision::Refuse { reason: "Eos is stopped".into() });
                    }
                    Ok(match request.class {
                        ActionClass::Read | ActionClass::WriteLocal | ActionClass::TellUser => ActionDecision::Run,
                        ActionClass::Irreversible => ActionDecision::Confirm {
                            prompt: format!("{} cannot be taken back. Type its name to go ahead.", request.title),
                        },
                        ActionClass::Speak => {
                            let at = Opening {
                                now,
                                ids: parts.ids.as_ref(),
                                zone: parts.zone.as_ref(),
                                control: parts.control.as_ref(),
                            };
                            let item = open_in(tx, out, &at, held_draft(&request))?;
                            ActionDecision::Hold { item_id: item.id }
                        }
                    })
                })
                .await?;
            Ok(decision)
        })
    }
}
