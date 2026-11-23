//! The `mail` channel (03's contract) over the Mail built-in's `send_mail`:
//! a mail result goes out as one plain mail to the one address its
//! delivery's target holds, the recipient the gate checked against the Goes
//! to the user confirmed. Nothing in the result adds who it goes to: a
//! `to:<recipient id>` part only picks among the routine's own recipients
//! at the gate, and is never read here.
//! Mail cannot take a mail back or say whether one went out, so a send
//! that may have gone out is left to the user.

use std::sync::Arc;

use eos_contracts::{ActionClass, ResultDoc};
use eos_core::BoxFuture;
use eos_core::capability::{ActionCall, ActionCaller};
use eos_core::delivery::{
    Channel, ChannelTraits, Fresh, Idempotency, Place, Receipt, SendError, SendErrorKind, SendRequest, Target, Undo,
    UndoOutcome,
};
use eos_domain::result_doc::shape::{PartKey, PartShape, ResultShape};
use eos_domain::result_doc::{MAIL, SUBJECT, paragraph_key};
use serde_json::{Value, json};

use crate::CapabilityService;
use crate::channels::send_error;

/// The channel, and the built-in it sends through.
pub(crate) const MAIL_CHANNEL: &str = "mail";
const SEND: &str = "send_mail";
/// The largest mail sent.
const MAIL_MAX_BYTES: usize = 5 * 1024 * 1024;

fn failure(detail_kind: &str) -> SendError {
    SendError { kind: SendErrorKind::Permanent, detail_kind: detail_kind.to_owned() }
}

/// What a mail result looks like: what [`mail_of`] reads.
pub(crate) fn mail_shape() -> ResultShape {
    let subject = PartShape {
        key: PartKey::One(SUBJECT.to_owned()),
        role: SUBJECT.to_owned(),
        name: "subject".to_owned(),
        required: true,
        what: "The mail's subject line.".to_owned(),
        values: Vec::new(),
        meta: Vec::new(),
        otherwise: None,
        example: "What came in overnight".to_owned(),
    };
    let paragraph = PartShape {
        key: PartKey::Each(paragraph_key),
        role: "paragraph".to_owned(),
        name: "paragraph".to_owned(),
        required: true,
        what: "One paragraph of the mail's text, in order.".to_owned(),
        values: Vec::new(),
        meta: Vec::new(),
        otherwise: None,
        example: "Three mails came in; one needs an answer today.".to_owned(),
    };
    ResultShape {
        kind: MAIL.to_owned(),
        channel: MAIL_CHANNEL.to_owned(),
        actions: vec![SEND.to_owned()],
        parts: vec![subject, paragraph],
        notes: vec![
            "Who the mail goes to comes from the routine's Goes to. A `to:<recipient id>` part may pick some of those recipients; with none it goes to every one. A mail can never add an address.".to_owned(),
            "Paragraphs are keyed `p:1`, `p:2`, … in the order they are read.".to_owned(),
        ],
    }
}

/// A mail result as the subject and text `send_mail` takes; what is wrong
/// when it is no mail.
pub(crate) fn mail_of(doc: &ResultDoc) -> Result<(String, String), String> {
    if doc.kind != MAIL {
        return Err(format!("kind `{}`: a mail is kind `{MAIL}`", doc.kind));
    }
    let subject = doc.parts.iter().find(|part| part.key == SUBJECT).map(|part| part.text.clone());
    let subject = subject.ok_or_else(|| "a mail needs a `subject` part".to_owned())?;
    let mut paragraphs: Vec<(usize, &str)> = Vec::new();
    for part in &doc.parts {
        if part.key == SUBJECT || part.key.starts_with("to:") {
            continue;
        }
        let n = part.key.strip_prefix("p:").and_then(|n| n.parse().ok());
        let n = n.ok_or_else(|| format!("part `{}`: a mail has `subject`, `p:<n>` and `to:<id>` parts", part.key))?;
        paragraphs.push((n, part.text.as_str()));
    }
    paragraphs.sort_by_key(|(n, _)| *n);
    let body: Vec<&str> = paragraphs.into_iter().map(|(_, text)| text).collect();
    Ok((subject, body.join("\n\n")))
}

/// The input `send_mail` takes for a mail to `to`.
pub(crate) fn send_input(to: &str, subject: &str, body: &str) -> Value {
    json!({ "to": to, "subject": subject, "body": body })
}

pub(crate) struct MailChannel(pub(crate) Arc<CapabilityService>);

impl MailChannel {
    async fn deliver(&self, req: &SendRequest) -> Result<Receipt, SendError> {
        if req.action != SEND || req.body.action != SEND {
            return Err(failure("action"));
        }
        let Place::Address(to) = &req.target.place else { return Err(failure("target")) };
        let (subject, body) = mail_of(&req.body).map_err(|_| failure("body"))?;
        if subject.len() + body.len() > MAIL_MAX_BYTES {
            return Err(failure("too_long"));
        }
        let call = ActionCall {
            capability: MAIL_CHANNEL.to_owned(),
            action: SEND.to_owned(),
            input: send_input(to, &subject, &body),
            caller: ActionCaller::Delivery { run_id: String::new(), delivery_id: req.key.clone() },
            idempotency_key: Some(req.key.clone()),
        };
        self.0.run_call(call).await.map_err(|e| send_error(&e, true))?;
        tracing::info!(capability = MAIL_CHANNEL, delivery_id = %req.key, "a mail went out");
        Ok(Receipt { id: req.key.clone(), url: None })
    }
}

impl Channel for MailChannel {
    fn traits(&self, action: &str) -> Option<ChannelTraits> {
        (action == SEND).then_some(ChannelTraits {
            class: ActionClass::Speak,
            idempotency: Idempotency::None,
            undo: Undo::None,
            undo_window_ms: 0,
            max_bytes: MAIL_MAX_BYTES,
        })
    }

    fn precondition<'a>(&'a self, _req: &'a SendRequest) -> BoxFuture<'a, Result<Fresh, SendError>> {
        Box::pin(std::future::ready(Ok(Fresh::Fresh)))
    }

    fn send<'a>(&'a self, req: &'a SendRequest) -> BoxFuture<'a, Result<Receipt, SendError>> {
        Box::pin(self.deliver(req))
    }

    fn lookup<'a>(&'a self, _key: &'a str, _target: &'a Target) -> BoxFuture<'a, Result<Option<Receipt>, SendError>> {
        // Mail cannot tell whether a mail went out.
        Box::pin(std::future::ready(Ok(None)))
    }

    fn undo<'a>(&'a self, _receipt: &'a Receipt) -> BoxFuture<'a, Result<UndoOutcome, SendError>> {
        Box::pin(std::future::ready(Err(failure("no_undo"))))
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::Part;

    use super::*;

    fn part(key: &str, text: &str) -> Part {
        Part { key: key.into(), role: String::new(), text: text.into(), meta: Default::default() }
    }

    #[test]
    fn a_mail_is_its_subject_and_its_paragraphs_in_order_whatever_it_names() {
        let doc = ResultDoc {
            kind: MAIL.into(),
            channel: MAIL_CHANNEL.into(),
            action: SEND.into(),
            parts: vec![
                part("p:2", "Second."),
                part("to:evil", "evil@attacker.example"),
                part(SUBJECT, "Overnight"),
                part("p:1", "First."),
            ],
        };
        assert_eq!(mail_of(&doc), Ok(("Overnight".into(), "First.\n\nSecond.".into())));
        let mut review = doc.clone();
        review.kind = "github.review".into();
        assert!(mail_of(&review).is_err());
        let mut odd = doc;
        odd.parts.push(part("cc", "evil@attacker.example"));
        assert!(mail_of(&odd).is_err_and(|found| found.contains("`cc`")));
    }
}
