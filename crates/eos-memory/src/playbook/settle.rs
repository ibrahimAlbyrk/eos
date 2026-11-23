//! A later night: each candidate whose replays ended is scored (each
//! replay's result and the original run's, against what the user sent
//! instead) and kept as the playbook's next version when it comes closer.

use eos_contracts::{ExperienceChange, ResultDoc};
use eos_core::Error;
use eos_core::store::{Outbox, StoredReplay, Tx};
use eos_domain::experience::NoteBody;
use eos_domain::experience::playbook::{beats, edit_similarity, text_of};
use serde_json::Value;

use super::{Trial, WAIT_MS, playbook_in, playbook_note, put_trials_in, trials_in};
use crate::merge::{MEMORY_CHANGE, version};

/// Every string a result's body holds, in order.
fn body_text(body: &str) -> String {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => out.push(text.clone()),
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            Value::Object(map) => map.values().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(&serde_json::from_str(body).unwrap_or(Value::Null), &mut out);
    out.join(" ")
}

/// What the user sent: the parts of the edited result.
fn sent_text(doc: &str) -> Option<String> {
    let doc: ResultDoc = serde_json::from_str(doc).ok()?;
    Some(doc.parts.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join(" "))
}

fn result_text_in(tx: &dyn Tx, run_id: &str) -> Result<Option<String>, Error> {
    Ok(tx.run_results().by_run(run_id)?.last().map(|result| body_text(&result.body)))
}

/// The old and new scores of a trial over the items both results exist for.
fn scores_in(tx: &dyn Tx, trial: &Trial) -> Result<(i64, f64, f64), Error> {
    let (mut items, mut old, mut new) = (0, 0.0, 0.0);
    if trial.past.len() != trial.replays.len() {
        return Ok((0, 0.0, 0.0));
    }
    for (past, replay) in trial.past.iter().zip(&trial.replays) {
        let Some(edit) = tx.inbox_edits().find(past.edit_id)? else { continue };
        let Some(sent) = sent_text(&edit.edit.after) else { continue };
        let (Some(first), Some(again)) = (result_text_in(tx, &past.run_id)?, result_text_in(tx, replay)?) else {
            continue;
        };
        items += 1;
        old += edit_similarity(&first, &sent);
        new += edit_similarity(&again, &sent);
    }
    if items == 0 {
        return Ok((0, 0.0, 0.0));
    }
    Ok((items, old / items as f64, new / items as f64))
}

/// Keeps `trial`'s lines as the playbook's next version; answers that
/// version, or `None` when the playbook changed since it was written.
fn keep_in(tx: &dyn Tx, out: &mut Outbox, trial: &Trial, now: i64, device: &str) -> Result<Option<i64>, Error> {
    let current = playbook_in(tx, &trial.routine_id)?;
    if current.as_ref().map_or(0, |n| n.rev) != trial.base_rev {
        return Ok(None);
    }
    let (note, rev, action) = match current {
        Some(stored) => {
            let mut note = stored.note.clone();
            note.text = text_of(&trial.lines);
            note.body = NoteBody::Playbook { lines: trial.lines.clone() };
            note.updated_at = now.max(note.updated_at);
            note.device = device.to_owned();
            tx.mem_notes().update(&note, &stored.cues, stored.rev + 1)?;
            (note, stored.rev + 1, "changed")
        }
        None => {
            let note = playbook_note(&trial.id, &trial.routine_id, trial.lines.clone(), now, device);
            tx.mem_notes().insert(&note, "")?;
            (note, 1, "learned")
        }
    };
    tx.mem_versions().insert(&version(&note, rev, "rewritten", now))?;
    out.push(MEMORY_CHANGE, &ExperienceChange { ids: vec![note.id], action: action.into() });
    Ok(Some(rev))
}

/// Scores every candidate whose replays ended (or that waited a day) in one
/// write job, keeps the winners and records each check.
pub(super) fn settle_in(tx: &dyn Tx, out: &mut Outbox, now: i64, device: &str) -> Result<(usize, usize), Error> {
    let (mut scored, mut kept) = (0, 0);
    let mut waiting = Vec::new();
    for trial in trials_in(tx)? {
        let mut ended = true;
        for id in &trial.replays {
            ended &= tx.runs().find(id)?.is_none_or(|run| run.state.is_terminal());
        }
        if !ended && now - trial.at < WAIT_MS {
            waiting.push(trial);
            continue;
        }
        let (items, old_score, new_score) = scores_in(tx, &trial)?;
        let won = items > 0 && beats(old_score, new_score);
        let rev = if won { keep_in(tx, out, &trial, now, device)? } else { None };
        let version = rev.unwrap_or(trial.base_rev);
        tx.mem_book().add_replay(&StoredReplay {
            id: trial.id.clone(),
            routine_id: trial.routine_id.clone(),
            version,
            items,
            old_score,
            new_score,
            kept: rev.is_some(),
            at: now,
        })?;
        scored += 1;
        kept += usize::from(rev.is_some());
    }
    put_trials_in(tx, &waiting)?;
    Ok((scored, kept))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_reads_as_its_strings_and_a_doc_as_its_parts() {
        assert_eq!(body_text(r#"{"summary":"a b","comments":[{"body":"c","line":3}]}"#), "a b c");
        let doc = r#"{"kind":"k","channel":"c","action":"a","parts":[{"key":"s","role":"r","text":"x y"}]}"#;
        assert_eq!(sent_text(doc).as_deref(), Some("x y"));
    }
}
