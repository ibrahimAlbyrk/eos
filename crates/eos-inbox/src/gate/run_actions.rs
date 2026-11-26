//! What becomes of an action a run's agent calls that tells the user,
//! speaks for them or cannot be taken back (D73), inside a write job of its
//! own: the same Freedom, caps and rows as the run's result. Nothing goes
//! while Eos is stopped or from a trial. Telling the user runs at once
//! (D67). What cannot be taken back waits for the user. A send for the
//! user goes out by itself only at a rung above drafts, through the
//! delivery engine, so its hold, undo and "that was wrong" are those of any
//! send; otherwise it waits in Needs you as a draft the user sends. Neither
//! moves the run: it goes on, and ends by its own result.

use eos_contracts::{ActionClass, Rung};
use eos_core::capability::{RunAction, RunActionDecision};
use eos_core::delivery::{Place, Target};
use eos_core::routine::{GateInput, GateMode};
use eos_core::store::{Outbox, Tx};
use eos_core::{Error, Ids};
use eos_domain::freedom::{Caps, effective_rung};
use eos_domain::inbox::ItemKind;
use eos_domain::outbound;
use eos_domain::result_doc::action_capability;
use eos_domain::run_scope::Trust;
use serde_json::json;

use super::apply::{context, held_freedom, trusted_facts};
use super::repeat::{About, sent_before_in};
use super::{DRAFT_PRODUCER, Gate};
use crate::delivery::{NewDelivery, queue_in, target_value};
use crate::{NewItem, Opening, open_in};

/// What the agent reads when Eos is stopped.
pub const STOPPED: &str = "Eos is stopped: nothing goes out until the user starts it again. Go on without it.";
/// What the agent reads in a trial.
pub const TRIAL: &str =
    "This is a trial: nothing is sent from it. Say in your result what you would have sent, and to whom.";

/// How a run's action reads to the user: its capability and action.
pub(crate) fn action_title(channel: &str, action: &str) -> String {
    format!("{} · {}", action_capability(channel).unwrap_or(channel), action.replace('_', " "))
}

/// Where the action goes: the user, or whom its input names, keyed by its
/// capability so two capabilities' people never meet (D55).
fn target_of(action: &RunAction) -> Target {
    if action.to_user {
        return Target { recipient_id: format!("{}:me", action.capability), place: Place::Me };
    }
    let to = action.recipient.clone().unwrap_or_default();
    Target { recipient_id: format!("{}:{to}", action.capability), place: Place::Address(to) }
}

pub(crate) fn action_in(
    gate: &Gate,
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    ids: &dyn Ids,
    input: &GateInput,
    action: &RunAction,
) -> Result<RunActionDecision, Error> {
    if tx.inbox_halt().get()?.on {
        return Ok(RunActionDecision::Refused { reason: STOPPED.to_owned() });
    }
    if input.result_mode == GateMode::Trial {
        return Ok(RunActionDecision::Refused { reason: TRIAL.to_owned() });
    }
    if action.class == ActionClass::TellUser && action.to_user {
        return Ok(RunActionDecision::Run);
    }
    let target = target_of(action);
    let run = tx.runs().find(&input.run_id)?;
    let about = run.as_ref().map_or(About { subject: None, version: None }, About::of);
    let traits = gate.channels.get(&input.doc.channel).and_then(|channel| channel.traits(&input.doc.action));
    let flags = outbound::check(&input.doc, &context(input, &[], traits.as_ref()));
    let caps = Caps {
        agent_origin: input.origin == "agent",
        flagged: !flags.is_empty(),
        repeat: sent_before_in(tx, gate.zone.as_ref(), now, &input.routine_id, &target.recipient_id, &about)?,
        ..Caps::default()
    };
    let freedom = input.freedom_confirmed.clone().unwrap_or_else(held_freedom);
    let rung = match action.class {
        // What cannot be taken back, and a "tell the user" that reaches
        // someone else, never go without the user.
        ActionClass::Irreversible | ActionClass::TellUser => Rung::Draft,
        class => effective_rung(class, &freedom, &trusted_facts(input), &caps),
    };
    let control = gate.control()?;
    let at = Opening { now, ids, zone: gate.zone.as_ref(), control: control.as_ref() };
    let traits = match traits {
        Some(traits) if input.result_mode == GateMode::AsUsual && rung > Rung::Draft => traits,
        _ => {
            let summary = match action.class {
                ActionClass::Irreversible => "An agent of this run wants to do this. It cannot be taken back.",
                _ => "An agent of this run wants to send this. It waits for you.",
            };
            let draft = NewItem {
                kind: ItemKind::Draft,
                producer: DRAFT_PRODUCER.to_owned(),
                routine_id: Some(input.routine_id.clone()),
                run_id: Some(input.run_id.clone()),
                subject_key: None,
                title: action_title(&input.doc.channel, &input.doc.action),
                summary: summary.to_owned(),
                payload: json!({
                    "doc": input.doc,
                    "flags": flags.iter().map(|flag| flag.as_str()).collect::<Vec<_>>(),
                    "targets": [target_value(&target)],
                    "rung": rung,
                    "untrusted": input.trust == Trust::Untrusted,
                }),
                by_hand: input.origin == "hand",
            };
            let item = open_in(tx, out, &at, draft)?;
            tracing::info!(run_id = %input.run_id, item_id = %item.id, rung = ?rung, flags = flags.len(), "a run's action was held");
            return Ok(RunActionDecision::Held { item_id: item.id });
        }
    };
    let new = NewDelivery {
        run_id: &input.run_id,
        routine_id: &input.routine_id,
        doc: &input.doc,
        target: &target,
        traits: &traits,
        item_id: None,
    };
    let row = queue_in(tx, out, now, ids, new)?;
    tracing::info!(run_id = %input.run_id, delivery_id = %row.id, rung = ?rung, "a run's action goes out");
    gate.wake.notify_one();
    Ok(RunActionDecision::Queued { delivery_id: row.id })
}
