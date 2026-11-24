//! The `slack` channel (03's contract, 06 §4.7) over the Slack built-in's
//! posts. Where a message goes comes from the delivery's target alone: an
//! address is a conversation or a person (their direct message), `Me` is
//! the user's own direct message, and an item is the thread of that Slack
//! message. Nothing in the result chooses it. The built-in escapes every
//! broadcast, turns link previews off and marks each post with the
//! delivery's key, which `lookup` finds again after a lost answer. A post is
//! taken back by deleting it, for a day.

use std::sync::Arc;

use eos_contracts::{ActionClass, ResultDoc};
use eos_core::BoxFuture;
use eos_core::capability::{ActionCall, ActionCaller, ActionError, FailureKind};
use eos_core::delivery::{
    Channel, ChannelTraits, Fresh, Idempotency, Place, Receipt, SendError, SendErrorKind, SendRequest, Target, Undo,
    UndoOutcome,
};
use eos_domain::result_doc::shape::{PartKey, PartShape, ResultShape};
use eos_domain::result_doc::{SLACK_MESSAGE, SLACK_REPLY, paragraph_key};
use serde_json::{Value, json};

use crate::CapabilityService;
use crate::channels::send_error;

/// The channel, and the built-in it sends through.
pub(crate) const SLACK: &str = "slack";
const POST: &str = "post_message";
const REPLY: &str = "reply_in_thread";
const TELL: &str = "tell_me";
/// The longest text a post takes, in characters.
const TEXT_MAX: usize = 4_000;
/// How long after a post it can be deleted.
const UNDO_MS: i64 = 24 * 60 * 60 * 1000;
/// What `find_delivery` reads for the user's own direct message.
const ME: &str = "@me";

fn failure(detail_kind: &str) -> SendError {
    SendError { kind: SendErrorKind::Permanent, detail_kind: detail_kind.to_owned() }
}

/// What a Slack result looks like: what [`text_of`] reads.
pub(crate) fn slack_shape(kind: &str) -> ResultShape {
    let paragraph = PartShape {
        key: PartKey::Each(paragraph_key),
        role: "paragraph".to_owned(),
        name: "paragraph".to_owned(),
        required: true,
        what: "One paragraph of the message, in order.".to_owned(),
        values: Vec::new(),
        meta: Vec::new(),
        otherwise: None,
        example: "The build is green again; *two* tests were flaky.".to_owned(),
    };
    let (actions, goes) = if kind == SLACK_REPLY {
        (vec![REPLY.to_owned()], "It is a reply in the thread of the run's Slack message.")
    } else {
        (
            vec![POST.to_owned(), TELL.to_owned()],
            "Who it goes to comes from the routine's Goes to; a message names no recipient.",
        )
    };
    ResultShape {
        kind: kind.to_owned(),
        channel: SLACK.to_owned(),
        actions,
        parts: vec![paragraph],
        notes: vec![
            goes.to_owned(),
            "Slack text: `*bold*`, `_italic_`, `<https://…|label>`; no `@channel`, `@here` or `@everyone`.".to_owned(),
            format!("At most {TEXT_MAX} characters."),
        ],
    }
}

/// A Slack result's text: its paragraphs in order; what is wrong when it
/// is none.
pub(crate) fn text_of(doc: &ResultDoc) -> Result<String, String> {
    if doc.kind != SLACK_MESSAGE && doc.kind != SLACK_REPLY {
        return Err(format!("kind `{}`: a Slack message is kind `{SLACK_MESSAGE}` or `{SLACK_REPLY}`", doc.kind));
    }
    let mut paragraphs: Vec<(usize, &str)> = Vec::new();
    for part in &doc.parts {
        let n = part.key.strip_prefix("p:").and_then(|n| n.parse().ok());
        let n = n.ok_or_else(|| format!("part `{}`: a Slack message has `p:<n>` parts only", part.key))?;
        paragraphs.push((n, part.text.as_str()));
    }
    if paragraphs.is_empty() {
        return Err("a Slack message needs at least one `p:<n>` paragraph".to_owned());
    }
    paragraphs.sort_by_key(|(n, _)| *n);
    Ok(paragraphs.into_iter().map(|(_, text)| text).collect::<Vec<_>>().join("\n\n"))
}

/// The conversation and the message's `ts` a Slack item key names
/// (`slack:<team>:<conversation>:<ts>`).
fn thread_of(key: &str) -> Option<(String, String)> {
    let mut parts = key.strip_prefix("slack:")?.splitn(3, ':');
    let (_team, conversation, ts) = (parts.next()?, parts.next()?, parts.next()?);
    (!conversation.is_empty() && !ts.is_empty()).then(|| (conversation.to_owned(), ts.to_owned()))
}

/// The action that sends to `target` and its input with `text`.
fn send_of(target: &Target, text: &str) -> Result<(&'static str, Value), SendError> {
    match &target.place {
        Place::Address(to) => Ok((POST, json!({ "to": to, "text": text }))),
        Place::Me => Ok((TELL, json!({ "text": text }))),
        Place::Item(key) => {
            let (conversation, ts) = thread_of(key).ok_or_else(|| failure("target"))?;
            Ok((REPLY, json!({ "conversation": conversation, "threadTs": ts, "text": text })))
        }
    }
}

/// A send's failure as delivery reads it; a workspace that forbids
/// deleting says so.
fn slack_error(error: &ActionError, sending: bool) -> SendError {
    match error {
        ActionError::Failed { kind: FailureKind::NotAllowed } => failure("cant_delete_message"),
        ActionError::Invalid(_) => failure("too_long"),
        other => send_error(other, sending),
    }
}

pub(crate) struct SlackChannel(pub(crate) Arc<CapabilityService>);

impl SlackChannel {
    async fn call(&self, action: &str, input: Value, key: Option<&str>) -> Result<Value, ActionError> {
        let call = ActionCall {
            capability: SLACK.to_owned(),
            action: action.to_owned(),
            input,
            caller: ActionCaller::Delivery { run_id: String::new(), delivery_id: key.unwrap_or_default().to_owned() },
            idempotency_key: key.map(str::to_owned),
        };
        Ok(self.0.run_call(call).await?.output)
    }

    async fn deliver(&self, req: &SendRequest) -> Result<Receipt, SendError> {
        if self.traits(&req.body.action).is_none() {
            return Err(failure("action"));
        }
        let text = text_of(&req.body).map_err(|_| failure("body"))?;
        if text.chars().count() > TEXT_MAX {
            return Err(failure("too_long"));
        }
        let (action, input) = send_of(&req.target, &text)?;
        let sent = self.call(action, input, Some(&req.key)).await.map_err(|e| slack_error(&e, true))?;
        tracing::info!(capability = SLACK, action, delivery_id = %req.key, "a Slack message went out");
        Ok(receipt(&sent))
    }

    async fn find(&self, key: &str, target: &Target) -> Result<Option<Receipt>, SendError> {
        let mut input = match &target.place {
            Place::Address(to) => json!({ "conversation": to }),
            Place::Me => json!({ "conversation": ME }),
            Place::Item(item) => {
                let (conversation, ts) = thread_of(item).ok_or_else(|| failure("target"))?;
                json!({ "conversation": conversation, "threadTs": ts })
            }
        };
        input["key"] = json!(key);
        input["since"] = json!(self.0.ports.clock.now_ms() - UNDO_MS);
        let found = self.call("find_delivery", input, Some(key)).await.map_err(|e| send_error(&e, false))?;
        if found["found"] != true {
            return Ok(None);
        }
        let conversation = found["conversation"].as_str().unwrap_or_default();
        let id = format!("{conversation}:{}", found["ts"].as_str().unwrap_or_default());
        Ok(Some(Receipt { id, url: found["permalink"].as_str().map(str::to_owned) }))
    }

    async fn delete(&self, receipt: &Receipt) -> Result<UndoOutcome, SendError> {
        let (conversation, ts) = receipt.id.split_once(':').ok_or_else(|| failure("receipt"))?;
        let input = json!({ "conversation": conversation, "ts": ts });
        self.call("delete_message", input, None).await.map_err(|e| slack_error(&e, false))?;
        Ok(UndoOutcome::Undone)
    }
}

/// What a post's answer gives the receipt: `<conversation>:<ts>` and its link.
fn receipt(sent: &Value) -> Receipt {
    let id =
        format!("{}:{}", sent["conversation"].as_str().unwrap_or_default(), sent["ts"].as_str().unwrap_or_default());
    Receipt { id, url: sent["permalink"].as_str().map(str::to_owned) }
}

impl Channel for SlackChannel {
    fn traits(&self, action: &str) -> Option<ChannelTraits> {
        let class = match action {
            POST | REPLY => ActionClass::Speak,
            TELL => ActionClass::TellUser,
            _ => return None,
        };
        Some(ChannelTraits {
            class,
            idempotency: Idempotency::Marker,
            undo: Undo::Full,
            undo_window_ms: UNDO_MS,
            max_bytes: TEXT_MAX * 4,
        })
    }

    fn precondition<'a>(&'a self, _req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>> {
        // A thread that went away fails the send itself as not found.
        Box::pin(std::future::ready(Ok(Fresh::Fresh)))
    }

    fn send<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>> {
        Box::pin(self.deliver(req))
    }

    fn lookup<'a>(&'a self, key: &'a str, target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>> {
        Box::pin(self.find(key, target))
    }

    fn undo<'a>(&'a self, receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        Box::pin(self.delete(receipt))
    }
}
