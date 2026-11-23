//! The `notify` built-in: telling the user, by a banner on this Mac and a
//! wake-up push to their phone (07's `PhoneNotify`), and the `notify`
//! channel a routine's "tell me" results go out through. The push carries a
//! kind and a count only, never the text; a phone that cannot be reached
//! leaves the banner, which already showed. Its health check passes while
//! the banner can show: checking the phone would wake it every hour.

use std::sync::Arc;

use eos_contracts::{ActionClass, ResultDoc};
use eos_core::BoxFuture;
use eos_core::agent::UserNotifier;
use eos_core::capability::{ActionCall, ActionCaller, ActionContext, ActionError, BuiltinCapability};
use eos_core::delivery::{
    Channel, ChannelTraits, Fresh, Idempotency, Place, Receipt, SendError, SendErrorKind, SendRequest, Target, Undo,
    UndoOutcome,
};
use eos_core::net::relay::{PhoneNotify, PhonePush, PushKind, PushOutcome};
use eos_domain::capability::health::Event;
use eos_domain::capability::manifest::Manifest;
use eos_domain::result_doc::shape::{PartKey, PartShape, ResultShape};
use eos_domain::result_doc::{BODY, TEXT};
use serde_json::{Value, json};

use crate::CapabilityService;
use crate::channels::send_error;

/// The capability's id, and its channel.
pub const NOTIFY: &str = "notify";
const TELL: &str = "tell";
/// The banner's title: the text is the user's own result.
const TITLE: &str = "Eos";
/// The longest text told.
const TELL_MAX_BYTES: usize = 4 * 1024;

pub struct Notify {
    manifest: Manifest,
    banner: Arc<dyn UserNotifier>,
    phone: Arc<dyn PhoneNotify>,
}

impl std::fmt::Debug for Notify {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Notify").finish_non_exhaustive()
    }
}

/// What a push's outcome says, as one word.
fn outcome_word(outcome: &Result<PushOutcome, eos_core::Error>) -> &'static str {
    match outcome {
        Ok(PushOutcome::Sent { .. }) => "sent",
        Ok(PushOutcome::NoDevices) => "no_devices",
        Ok(PushOutcome::LinkOff) => "link_off",
        Ok(PushOutcome::Throttled) => "throttled",
        Ok(PushOutcome::NotConfigured { .. }) => "not_configured",
        Err(_) => "unreachable",
    }
}

fn manifest() -> Manifest {
    let manifest = json!({
        "id": NOTIFY,
        "name": "Notify",
        "version": "1",
        "summary": "Tell you: a banner on this Mac and a wake-up on your phone.",
        "form": "builtin",
        "works": "this_mac",
        "health": { "action": "check" },
        "actions": [
            { "name": "check", "summary": "See that a banner can show.", "class": "read",
              "output": { "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] } },
            { "name": TELL, "summary": "Tell you something: a banner here, and a wake-up on your phone without the text.",
              "class": "tell_user",
              "input": { "type": "object", "properties": {
                  "body": { "type": "string", "minLength": 1, "maxLength": TELL_MAX_BYTES },
              }, "required": ["body"] },
              "output": { "type": "object", "properties": {
                  "banner": { "type": "boolean" }, "phone": { "type": "string" },
              }, "required": ["banner", "phone"] } },
        ],
    });
    // A test holds the manifest to the built-in check; this never fails.
    serde_json::from_value(manifest).unwrap_or_else(|e| panic!("the notify manifest does not parse: {e}"))
}

impl Notify {
    pub fn new(banner: Arc<dyn UserNotifier>, phone: Arc<dyn PhoneNotify>) -> Self {
        Self { manifest: manifest(), banner, phone }
    }

    async fn run(&self, action: &str, input: Value) -> Result<Value, ActionError> {
        match action {
            "check" => Ok(json!({ "ok": true })),
            TELL => {
                let body = input["body"].as_str().unwrap_or_default();
                self.banner.notify("", TITLE, body);
                let pushed = self.phone.push(PhonePush { kind: PushKind::Ready, count: 1 }).await;
                let phone = outcome_word(&pushed);
                tracing::info!(capability = NOTIFY, phone, "the user was told");
                Ok(json!({ "banner": true, "phone": phone }))
            }
            _ => Err(ActionError::NotFound),
        }
    }
}

impl BuiltinCapability for Notify {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        action: &'a str,
        input: Value,
        _ctx: &'a ActionContext,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        Box::pin(self.run(action, input))
    }

    fn health<'a>(&'a self, _ctx: &'a ActionContext) -> BoxFuture<'a, Event> {
        Box::pin(std::future::ready(Event::Passed))
    }
}

/// What a text result looks like: one body.
pub(crate) fn text_shape() -> ResultShape {
    let body = PartShape {
        key: PartKey::One(BODY.to_owned()),
        role: BODY.to_owned(),
        name: "text".to_owned(),
        required: true,
        what: "What to tell the user, in a sentence or two.".to_owned(),
        values: Vec::new(),
        meta: Vec::new(),
        otherwise: None,
        example: "Three mails came in overnight; one needs an answer today.".to_owned(),
    };
    ResultShape {
        kind: TEXT.to_owned(),
        channel: NOTIFY.to_owned(),
        actions: vec![TELL.to_owned()],
        parts: vec![body],
        notes: vec!["The user's phone is woken without the text; the text shows on this Mac.".to_owned()],
    }
}

/// A text result's body; what is wrong when it is none.
pub(crate) fn text_of(doc: &ResultDoc) -> Result<String, String> {
    if doc.kind != TEXT {
        return Err(format!("kind `{}`: a text is kind `{TEXT}`", doc.kind));
    }
    let body = doc.parts.iter().find(|part| part.key == BODY).map(|part| part.text.clone());
    body.ok_or_else(|| "a text needs a `body` part".to_owned())
}

pub(crate) struct NotifyChannel(pub(crate) Arc<CapabilityService>);

fn failure(detail_kind: &str) -> SendError {
    SendError { kind: SendErrorKind::Permanent, detail_kind: detail_kind.to_owned() }
}

impl NotifyChannel {
    async fn deliver(&self, req: &SendRequest) -> Result<Receipt, SendError> {
        if req.action != TELL || req.body.action != TELL {
            return Err(failure("action"));
        }
        // Only the user is told: a text names no one else.
        if req.target.place != Place::Me {
            return Err(failure("target"));
        }
        let body = text_of(&req.body).map_err(|_| failure("body"))?;
        let call = ActionCall {
            capability: NOTIFY.to_owned(),
            action: TELL.to_owned(),
            input: json!({ "body": body }),
            caller: ActionCaller::Delivery { run_id: String::new(), delivery_id: req.key.clone() },
            idempotency_key: Some(req.key.clone()),
        };
        self.0.run_call(call).await.map_err(|e| send_error(&e, true))?;
        Ok(Receipt { id: req.key.clone(), url: None })
    }
}

impl Channel for NotifyChannel {
    fn traits(&self, action: &str) -> Option<ChannelTraits> {
        (action == TELL).then_some(ChannelTraits {
            class: ActionClass::TellUser,
            idempotency: Idempotency::None,
            undo: Undo::None,
            undo_window_ms: 0,
            max_bytes: TELL_MAX_BYTES,
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

    fn undo<'a>(&'a self, _receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        Box::pin(std::future::ready(Err(failure("no_undo"))))
    }
}
