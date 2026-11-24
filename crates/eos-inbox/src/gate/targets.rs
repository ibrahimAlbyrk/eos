//! Where a result would go: the routine's recipients on the result's
//! channel (for a mail, those it names), each of which must be one the
//! user confirmed. The place each goes to comes from the recipient and the
//! run's item, never from the result's text.

use eos_contracts::{Facts, Part, Recipient, RecipientKind, ResultDoc};
use eos_core::delivery::{Place, Target};
use eos_core::routine::GateInput;
use eos_domain::result_doc::{MAIL, recipient_key};
use eos_domain::signals::which::{self, Verdict};

/// One place the result goes.
#[derive(Debug, Clone)]
pub(crate) struct Chosen {
    pub(crate) recipient: Recipient,
    pub(crate) target: Target,
    /// The blueprint bounds the place: a fixed address, the user, or an
    /// item place whose bound the item's facts pass.
    pub(crate) bounded: bool,
}

pub(crate) enum Targets {
    Go(Vec<Chosen>),
    /// The routine sends nowhere (a trial, or no Goes to): only shown.
    Nowhere,
    /// The result was meant to be sent and no place is left for it: held
    /// for the user, never only shown (D66).
    NoneLeft,
    /// A recipient the user has not confirmed (03 G14, G22).
    Unconfirmed,
}

fn channel_of(recipient: &Recipient) -> &str {
    match &recipient.kind {
        RecipientKind::Me { channel, .. }
        | RecipientKind::Fixed { channel, .. }
        | RecipientKind::ItemPlace { channel, .. } => channel,
    }
}

/// The recipients a mail names by its `to:` parts; none named, every one.
/// A part that names no confirmed recipient is ignored (D66).
fn named(doc: &ResultDoc, confirmed: &[Recipient], recipient: &Recipient) -> bool {
    let known = |name: &&str| confirmed.iter().any(|recipient| recipient.id == *name);
    let names: Vec<&str> = doc.parts.iter().filter_map(|part| part.key.strip_prefix("to:")).filter(known).collect();
    doc.kind != MAIL || names.is_empty() || names.contains(&recipient.id.as_str())
}

pub(crate) fn choose(input: &GateInput, facts: &Facts) -> Targets {
    let doc = &input.doc;
    if input.targets.is_empty() {
        return Targets::Nowhere;
    }
    let mut chosen = Vec::new();
    let named = |r: &&Recipient| named(doc, &input.goes_to_confirmed, r);
    for recipient in input.targets.iter().filter(|r| channel_of(r) == doc.channel).filter(named) {
        if !input.goes_to_confirmed.contains(recipient) {
            return Targets::Unconfirmed;
        }
        let (place, bounded) = match &recipient.kind {
            RecipientKind::Me { .. } => (Place::Me, true),
            RecipientKind::Fixed { address, .. } => (Place::Address(address.clone()), true),
            RecipientKind::ItemPlace { bound, .. } => {
                // No item, no place.
                let Some(key) = input.subject_key.clone() else { continue };
                let bounded = bound.as_ref().is_some_and(|rule| which::evaluate(rule, facts) == Verdict::Pass);
                (Place::Item(key), bounded)
            }
        };
        let target = Target { recipient_id: recipient.id.clone(), place };
        chosen.push(Chosen { recipient: recipient.clone(), target, bounded });
    }
    if chosen.is_empty() { Targets::NoneLeft } else { Targets::Go(chosen) }
}

/// What a recipient part of a mail shows the user.
fn readable(recipient: &Recipient) -> String {
    match &recipient.kind {
        RecipientKind::Me { .. } => "You".to_owned(),
        RecipientKind::Fixed { address, .. } => address.clone(),
        RecipientKind::ItemPlace { .. } => "The item's sender".to_owned(),
    }
}

/// The result as the user sees it held: a mail names each recipient it
/// goes to in a readable `to:` part, so the user can untick one.
pub(crate) fn with_recipients(doc: &ResultDoc, chosen: &[Chosen]) -> ResultDoc {
    let mut doc = doc.clone();
    if doc.kind != MAIL {
        return doc;
    }
    for target in chosen {
        let key = recipient_key(&target.recipient.id);
        match doc.parts.iter_mut().find(|part| part.key == key) {
            Some(part) if part.text.trim().is_empty() => part.text = readable(&target.recipient),
            Some(_) => {}
            None => doc.parts.push(Part {
                key,
                role: "recipient".to_owned(),
                text: readable(&target.recipient),
                meta: Default::default(),
            }),
        }
    }
    doc
}
