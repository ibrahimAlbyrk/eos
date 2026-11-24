//! The gate's decision, inside the run's write job: show-only or trial,
//! targets, class, outbound check, rung under every cap, then held or
//! delivering (03 §4.8 "Gate"). No channel is called here: only its traits
//! are read.

use eos_contracts::{ActionClass, Facts, Freedom, ResultDoc, Rung};
use eos_core::Error;
use eos_core::Ids;
use eos_core::delivery::ChannelTraits;
use eos_core::routine::{GateDecision, GateInput, GateMode, RunOutcomes};
use eos_core::store::{Outbox, Tx};
use eos_domain::freedom::{Caps, effective_rung};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::outbound::{self, Flag, OutboundContext};
use eos_domain::run_scope::Trust;
use serde_json::{Map, Value, json};

use super::repeat::sent_before_in;
use super::targets::{Chosen, Targets, choose, with_recipients};
use super::{Gate, run_subject, subject_of};
use crate::delivery::{NewDelivery, queue_in, target_value};
use crate::items::{ALERT_PRODUCER, open_replacing_in};
use crate::outcomes::replaced_in;
use crate::{NewItem, Opening, announce, open_in};

/// Why a routine whose result went to an unconfirmed recipient is paused,
/// and the subject of the alert that says so.
pub const TARGET_REFUSED: &str = "target_refused";
/// Who acts on a held draft's answer: Needs you itself.
pub(crate) const DRAFT_PRODUCER: &str = "inbox";

pub(crate) fn apply_in(
    gate: &Gate,
    tx: &dyn Tx,
    out: &mut Outbox,
    now: i64,
    ids: &dyn Ids,
    input: &GateInput,
) -> Result<GateDecision, Error> {
    // Neither writes a row of any kind (03 G21).
    if matches!(input.result_mode, GateMode::ShowOnly | GateMode::Trial) {
        return Ok(GateDecision::Shown);
    }
    let control = gate.control()?;
    let at = Opening { now, ids, zone: gate.zone.as_ref(), control: control.as_ref() };
    let facts = trusted_facts(input);
    let chosen = match choose(input, &facts) {
        Targets::Go(chosen) => chosen,
        Targets::Nowhere => return Ok(GateDecision::Shown),
        Targets::Unconfirmed => {
            refuse_in(tx, out, &at, input)?;
            return Ok(GateDecision::Refused);
        }
    };
    let traits = gate.channels.get(&input.doc.channel).and_then(|channel| channel.traits(&input.doc.action));
    // An action no channel offers is never sent by itself.
    let class = traits.map_or(ActionClass::Irreversible, |traits| traits.class);
    let flags = outbound::check(&input.doc, &context(input, &chosen, traits.as_ref()));
    let caps = Caps {
        agent_origin: input.origin == "agent",
        unbounded_place: chosen.iter().any(|target| !target.bounded),
        flagged: !flags.is_empty(),
        stale: false,
        waiting: None,
        halted: tx.inbox_halt().get()?.on,
        repeat: repeat_in(tx, input, &chosen)?,
    };
    let freedom = input.freedom_confirmed.clone().unwrap_or_else(held_freedom);
    let rung = effective_rung(class, &freedom, &facts, &caps);
    let doc = with_recipients(&input.doc, &chosen);
    let traits = match traits {
        Some(traits) if input.result_mode == GateMode::AsUsual && rung > Rung::Draft => traits,
        _ => {
            let held = Held { doc: &doc, chosen: &chosen, flags: &flags, rung };
            let item_id = hold_in(tx, out, &at, gate.outcomes()?.as_ref(), input, held)?;
            tracing::info!(run_id = %input.run_id, item_id, rung = ?rung, flags = flags.len(), "a result was held");
            return Ok(GateDecision::Held { item_id });
        }
    };
    let mut delivery_ids = Vec::new();
    for target in &chosen {
        let new = NewDelivery {
            run_id: &input.run_id,
            routine_id: &input.routine_id,
            doc: &doc,
            target: &target.target,
            traits: &traits,
            item_id: None,
        };
        delivery_ids.push(queue_in(tx, out, now, ids, new)?.id);
    }
    tracing::info!(run_id = %input.run_id, deliveries = delivery_ids.len(), rung = ?rung, "a result goes out");
    gate.wake.notify_one();
    Ok(GateDecision::Delivering { delivery_ids })
}

/// Whether any place the result goes already had a send of the run's
/// subject from this routine (D55).
fn repeat_in(tx: &dyn Tx, input: &GateInput, chosen: &[Chosen]) -> Result<bool, Error> {
    let subject = tx.runs().find(&input.run_id)?.as_ref().and_then(run_subject);
    for target in chosen {
        if sent_before_in(tx, &input.routine_id, &target.target.recipient_id, subject.as_deref())? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The Freedom of a routine the user stands behind no version of: held.
fn held_freedom() -> Freedom {
    Freedom { rung: Rung::Draft, grants: Vec::new(), extra: Map::new() }
}

/// The item's facts, for its grants and the bounds of item places: each
/// field of the item a fact can be.
fn facts_of(item: &Value) -> Facts {
    let fields = item.as_object().into_iter().flatten();
    fields.filter_map(|(name, value)| Some((name.clone(), serde_json::from_value(value.clone()).ok()?))).collect()
}

/// The facts grants and the bounds of item places read: what the source
/// read wins over the item's own fields of the same name, and a fact the
/// item's sender writes is left out, so a rule resting on it never passes
/// (D63). An item from outside writes its own title, text and key.
fn trusted_facts(input: &GateInput) -> Facts {
    let mut facts = facts_of(&input.item_facts);
    facts.extend(input.signal_facts.clone());
    if input.item_facts.get("untrusted") != Some(&Value::Bool(false)) {
        for field in ["title", "text", "key"] {
            facts.shift_remove(field);
        }
    }
    facts.retain(|name, _| !input.untrusted_facts.contains(name));
    facts
}

/// What the result may name without a flag: what its item names, and the
/// addresses the user wrote into the Goes to. An item from outside names
/// nothing by its title, text or key: whoever wrote them would choose who
/// the result may mention or link to (a mail's key is its Message-ID, which
/// its sender writes).
fn context(input: &GateInput, chosen: &[Chosen], traits: Option<&ChannelTraits>) -> OutboundContext {
    let mut context = OutboundContext::new(traits.map_or(usize::MAX, |traits| traits.max_bytes));
    let mut named = input.item_facts.clone();
    if let Some(fields) = named.as_object_mut().filter(|fields| fields.get("untrusted") != Some(&Value::Bool(false))) {
        fields.remove("title");
        fields.remove("text");
        fields.remove("key");
    }
    context.add_from(&named.to_string());
    for target in chosen {
        if let eos_core::delivery::Place::Address(address) = &target.target.place {
            context.add_from(address);
        }
    }
    context
}

/// A recipient the user has not confirmed: nothing is sent, the routine is
/// paused and the user is told once.
fn refuse_in(tx: &dyn Tx, out: &mut Outbox, at: &Opening<'_>, input: &GateInput) -> Result<(), Error> {
    at.control.pause_in(tx, out, &input.routine_id, TARGET_REFUSED)?;
    tracing::info!(run_id = %input.run_id, routine_id = %input.routine_id, "a result to an unconfirmed recipient was refused");
    let alert = NewItem {
        kind: ItemKind::RoutineAlert,
        producer: ALERT_PRODUCER.to_owned(),
        routine_id: Some(input.routine_id.clone()),
        run_id: Some(input.run_id.clone()),
        subject_key: Some(TARGET_REFUSED.to_owned()),
        title: "A result was not sent".to_owned(),
        summary: "It would have gone to someone you have not confirmed. The routine is paused.".to_owned(),
        payload: json!({ "reason": TARGET_REFUSED }),
        by_hand: input.origin == "hand",
    };
    open_in(tx, out, at, alert).map(drop)
}

/// A result the gate holds.
struct Held<'a> {
    doc: &'a ResultDoc,
    chosen: &'a [Chosen],
    flags: &'a [Flag],
    rung: Rung,
}

/// The result as a `draft` item, with what the run cost and what its check
/// said, and what its send needs: the targets the gate checked, the rung it
/// was held at and whether outside text made it; its id. The run of a
/// draft it replaced ends as `replaced`, in the same job.
fn hold_in(
    tx: &dyn Tx,
    out: &mut Outbox,
    at: &Opening<'_>,
    outcomes: &dyn RunOutcomes,
    input: &GateInput,
    held: Held<'_>,
) -> Result<String, Error> {
    let run = tx.runs().find(&input.run_id)?.ok_or_else(|| Error::not_found("run", input.run_id.clone()))?;
    let verdict = tx.run_results().by_run(&run.id)?.into_iter().find(|result| result.attempt == run.attempt);
    let verdict = verdict.and_then(|result| result.verdict).and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let draft = NewItem {
        kind: ItemKind::Draft,
        producer: DRAFT_PRODUCER.to_owned(),
        routine_id: Some(input.routine_id.clone()),
        run_id: Some(input.run_id.clone()),
        subject_key: input.subject_key.as_deref().map(|key| subject_of(key, input.item_facts["version"].as_str())),
        title: run.headline.clone().unwrap_or_else(|| "A result to send".to_owned()),
        summary: "It waits for you to send it.".to_owned(),
        payload: json!({
            "doc": held.doc,
            "flags": held.flags.iter().map(|flag| flag.as_str()).collect::<Vec<_>>(),
            "costUsd": run.cost_usd,
            "verdict": verdict,
            "targets": held.chosen.iter().map(|chosen| target_value(&chosen.target)).collect::<Vec<_>>(),
            "rung": held.rung,
            "untrusted": input.trust == Trust::Untrusted,
            // A subject event that repeats this version does not make it stale.
            "subjectVersion": input.item_facts["version"],
        }),
        by_hand: input.origin == "hand",
    };
    let (item, replaced) = open_replacing_in(tx, out, at, draft)?;
    replaced_in(tx, out, outcomes, &replaced, &item)?;
    Ok(item.id)
}

/// Takes back the run's draft that waits (01 G18): the user told the team
/// something, and the work reopens.
pub(crate) fn withdraw_in(tx: &dyn Tx, out: &mut Outbox, now: i64, run_id: &str) -> Result<(), Error> {
    let Some(run) = tx.runs().find(run_id)? else { return Ok(()) };
    for mut item in tx.inbox_items().waiting_of_routine(&run.routine_id)? {
        if item.kind != ItemKind::Draft || item.run_id.as_deref() != Some(run_id) {
            continue;
        }
        let rev = item.rev;
        item.state = ItemState::Withdrawn;
        item.rev += 1;
        item.updated_at = now;
        if tx.inbox_items().update_waiting(&item, rev)? {
            tracing::info!(item_id = %item.id, run_id, "a held result was withdrawn");
            announce(tx, out, &item)?;
        }
    }
    Ok(())
}
