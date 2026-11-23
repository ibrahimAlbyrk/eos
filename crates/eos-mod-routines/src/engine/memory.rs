//! Memory at the stations (01 §4.7, 04 §6): the lead starts with the notes
//! recalled for its item, and memory hears how each run ended, each check
//! its checker failed, and each routine that left for good. Memory failing
//! never holds up a run: it is logged and the run goes on without it.

use eos_contracts::{RunChange, RunInput};
use eos_core::experience::{CheckVerdict, RunOutcome, RunPackRequest};
use eos_domain::experience::cues;
use eos_domain::routine::run::RunState;

use super::Engine;
use super::workspace::Place;

/// The run kind of a trial: its notes come, but nothing is credited.
const TRIAL: &str = "trial";
/// The origin of a replay, whose reference is its playbook candidate.
const REPLAY: &str = "replay";

/// The notes for a run's lead, as the block its start carries; `None` when
/// nothing applies.
pub(crate) async fn pack(
    engine: &Engine,
    run_id: &str,
    routine_id: &str,
    input: &RunInput,
    place: &Place,
) -> Option<String> {
    let id = run_id.to_owned();
    let read = engine.store.read(move |tx| {
        Ok(tx.runs().find(&id)?.map(|run| {
            let candidate = run.origin_ref.filter(|_| run.origin == REPLAY);
            (run.kind == TRIAL, candidate)
        }))
    });
    let (trial, playbook_candidate) = match read.await {
        Ok(found) => found.unwrap_or((false, None)),
        Err(error) => {
            tracing::warn!(run_id, %error, "a run's notes were not asked for");
            return None;
        }
    };
    let project = match place {
        Place::Folder { dir, .. } => Some(engine.keys.to_key(dir).await),
        Place::Worktree { repo, .. } => Some(engine.keys.to_key(repo).await),
        Place::Scratch => None,
    };
    let items: Vec<_> = input.item.iter().chain(input.items.iter().flatten()).collect();
    let item_cues =
        items.iter().filter_map(|item| item.path.as_deref()).flat_map(|path| cues::path_cues(path, None)).collect();
    // Only a search reads the item's text: outside text never teaches.
    let item_text = items
        .iter()
        .flat_map(|item| [item.title.as_deref(), item.text.as_deref()])
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");
    let request = RunPackRequest {
        run_id: run_id.to_owned(),
        routine_id: routine_id.to_owned(),
        project,
        item_cues,
        item_text,
        trial,
        playbook_candidate,
    };
    match engine.packs.for_run(request).await {
        Ok(pack) if !pack.text.trim().is_empty() => Some(pack.text),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(run_id, %error, "a run's notes could not be packed");
            None
        }
    }
}

/// Tells memory how a run that ended ended: its outcome once done,
/// `failed`, or the state it stopped in.
pub(crate) async fn run_ended(engine: &Engine, change: &RunChange) {
    let id = change.run_id.clone();
    let run = match engine.store.read(move |tx| tx.runs().find(&id)).await {
        Ok(Some(run)) => run,
        Ok(None) => return,
        Err(error) => return tracing::warn!(run_id = %change.run_id, %error, "a run's end was not told to memory"),
    };
    let kind = match (run.state, run.outcome) {
        (RunState::Done, Some(outcome)) => outcome.as_str().to_owned(),
        (RunState::Done, None) => "nothing".to_owned(),
        (state, _) => state.as_str().to_owned(),
    };
    let note = serde_json::from_str::<RunInput>(&run.input).ok().and_then(|input| input.note);
    let outcome = RunOutcome { run_id: run.id, routine_id: run.routine_id, note, kind };
    if let Err(error) = engine.feedback.run_ended(outcome).await {
        tracing::warn!(run_id = %change.run_id, %error, "a run's end was not told to memory");
    }
}

/// Tells memory the checker did not pass the lead's result.
pub(crate) async fn check_failed(engine: &Engine, run_id: &str, routine_id: &str, lead: &str) {
    let verdict =
        CheckVerdict { run_id: run_id.to_owned(), routine_id: routine_id.to_owned(), worker_id: lead.to_owned() };
    if let Err(error) = engine.feedback.check_failed(verdict).await {
        tracing::warn!(run_id, %error, "a failed check was not told to memory");
    }
}

/// Tells memory a routine left for good: its notes close.
pub(crate) async fn routine_removed(engine: &Engine, routine_id: &str) {
    if let Err(error) = engine.feedback.routine_removed(routine_id).await {
        tracing::warn!(routine_id, %error, "a routine's removal was not told to memory");
    }
}
