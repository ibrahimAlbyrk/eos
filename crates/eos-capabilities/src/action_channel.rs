//! The channel an action a run's agent called goes out through
//! (`action:<capability>`, D73): the delivery sends the action with the
//! input the user saw (`eos_domain::result_doc::action_input`), as a call
//! of the delivery. It is taken back by the action its manifest names as
//! its `undo`, with what that action takes of the sent input and its
//! answer, for a day. Only a built-in's manifest is at hand without a
//! read: an installed package's action is never taken back from here, so
//! a send of it waits out its hold first. Nothing marks what went out, so
//! a send whose answer was lost asks the user.

use std::sync::Arc;

use eos_contracts::ActionClass;
use eos_core::BoxFuture;
use eos_core::capability::{ActionCall, ActionCaller, ActionError};
use eos_core::delivery::{
    Channel, ChannelTraits, Fresh, Idempotency, Receipt, SendError, SendErrorKind, SendRequest, Target, Undo,
    UndoOutcome,
};
use eos_domain::result_doc::action_input;
use serde_json::{Map, Value, json};

use crate::CapabilityService;
use crate::channels::send_error;

/// How long after a send it can be taken back.
const UNDO_MS: i64 = 24 * 60 * 60 * 1000;

fn failure(detail_kind: &str) -> SendError {
    SendError { kind: SendErrorKind::Permanent, detail_kind: detail_kind.to_owned() }
}

pub(crate) struct ActionChannel {
    pub(crate) service: Arc<CapabilityService>,
    pub(crate) capability: String,
}

/// What the undo action takes of the sent input and its answer: the fields
/// its input schema names, the answer's winning.
fn undo_input(schema: Option<&Value>, input: &Value, output: &Value) -> Value {
    let named = |name: &String| schema.is_none_or(|schema| schema["properties"].get(name).is_some());
    let mut taken = Map::new();
    for fields in [input, output].into_iter().filter_map(Value::as_object) {
        taken.extend(fields.iter().filter(|(name, _)| named(name)).map(|(name, value)| (name.clone(), value.clone())));
    }
    Value::Object(taken)
}

impl ActionChannel {
    async fn call(&self, action: &str, input: Value, req: Option<&SendRequest>) -> Result<Value, ActionError> {
        let call = ActionCall {
            capability: self.capability.clone(),
            action: action.to_owned(),
            input,
            caller: ActionCaller::Delivery {
                run_id: req.map(|req| req.run_id.clone()).unwrap_or_default(),
                delivery_id: req.map(|req| req.key.clone()).unwrap_or_default(),
            },
            idempotency_key: req.map(|req| req.key.clone()),
        };
        Ok(self.service.run_call(call).await?.output)
    }

    async fn deliver(&self, req: &SendRequest) -> Result<Receipt, SendError> {
        let input = action_input(&req.body).ok_or_else(|| failure("body"))?;
        let sent = self.call(&req.action, input.clone(), Some(req)).await.map_err(|e| send_error(&e, true))?;
        tracing::info!(capability = %self.capability, action = %req.action, delivery_id = %req.key, "a run's action went out");
        let url = ["permalink", "url"].iter().find_map(|key| sent[*key].as_str()).map(str::to_owned);
        let loaded = self.service.load_one(&self.capability).await.ok().flatten();
        let manifest = loaded.as_ref().map(|loaded| &loaded.capability.manifest);
        let undo = manifest.and_then(|manifest| manifest.action(&manifest.action(&req.action)?.undo));
        let id = match undo {
            Some(undo) => {
                json!({"undo": undo.name, "input": undo_input(undo.input.as_ref(), &input, &sent)}).to_string()
            }
            None => String::new(),
        };
        Ok(Receipt { id, url })
    }

    async fn take_back(&self, receipt: &Receipt) -> Result<UndoOutcome, SendError> {
        let kept: Value = serde_json::from_str(&receipt.id).map_err(|_| failure("receipt"))?;
        let undo = kept["undo"].as_str().ok_or_else(|| failure("receipt"))?;
        self.call(undo, kept["input"].clone(), None).await.map_err(|e| send_error(&e, false))?;
        tracing::info!(capability = %self.capability, action = undo, "a run's action was taken back");
        Ok(UndoOutcome::Undone)
    }
}

impl Channel for ActionChannel {
    fn traits(&self, action: &str) -> Option<ChannelTraits> {
        let builtin = self.service.builtins.get(&self.capability);
        let declared = builtin.and_then(|builtin| builtin.manifest().action(action).cloned());
        let (class, undo) = match &declared {
            Some(declared) => (declared.class, if declared.undo.is_empty() { Undo::None } else { Undo::Full }),
            None if builtin.is_some() => return None,
            None => (ActionClass::Speak, Undo::None),
        };
        Some(ChannelTraits {
            class,
            idempotency: Idempotency::None,
            undo,
            undo_window_ms: if undo == Undo::None { 0 } else { UNDO_MS },
            max_bytes: usize::MAX,
        })
    }

    fn precondition<'a>(&'a self, _req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>> {
        Box::pin(std::future::ready(Ok(Fresh::Fresh)))
    }

    fn send<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>> {
        Box::pin(self.deliver(req))
    }

    fn lookup<'a>(&'a self, _key: &'a str, _target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>> {
        Box::pin(std::future::ready(Ok(None)))
    }

    fn undo<'a>(&'a self, receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        Box::pin(self.take_back(receipt))
    }
}
