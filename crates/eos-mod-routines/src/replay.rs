//! Playbook replays (01 G50): memory checks a rewritten playbook by running
//! the routine again on past runs' items with the candidate in its pack.
//! Each replay is a trial of the routine's head (kind `trial`, origin
//! `replay`, the candidate as its reference) that shows its result in
//! `run_results` and sends nothing; its notes earn no credit. It is given
//! the past run's options and note, so it is scored against a result made
//! the same way; a past run whose options the head no longer takes is left
//! out. Only an active routine is replayed, after every run the user asked
//! for.

use std::sync::Arc;

use eos_contracts::{ResultMode, RunInput};
use eos_core::BoxFuture;
use eos_core::routine::{NewRun, RunOrigin, RunReplays, StartError};

use crate::engine::{Engine, start_runs};

pub(crate) struct Replays(pub(crate) Arc<Engine>);

impl RunReplays for Replays {
    fn replay<'a>(
        &'a self,
        routine_id: &'a str,
        candidate: &'a str,
        run_ids: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<String>, StartError>> {
        Box::pin(replay(&self.0, routine_id, candidate, run_ids))
    }
}

async fn replay(
    engine: &Arc<Engine>,
    routine_id: &str,
    candidate: &str,
    run_ids: &[String],
) -> Result<Vec<String>, StartError> {
    let (routine, ids) = (routine_id.to_owned(), run_ids.to_vec());
    let past: Vec<RunInput> = engine
        .store
        .read(move |tx| {
            let mut past = Vec::new();
            for id in &ids {
                let Some(run) = tx.runs().find(id)?.filter(|run| run.routine_id == routine) else { continue };
                let input: Option<RunInput> = serde_json::from_str(&run.input).ok();
                past.extend(input.filter(|input| input.item.is_some()));
            }
            Ok(past)
        })
        .await?;
    // One start a past run: a routine may take one item at a time.
    let mut made = Vec::with_capacity(past.len());
    for input in past {
        let new = NewRun {
            routine_id: routine_id.to_owned(),
            version: None,
            input: RunInput {
                item: input.item,
                items: None,
                trigger: None,
                options: input.options,
                note: input.note,
                result: ResultMode::ShowOnly,
                at: None,
                surface: None,
            },
            items: Vec::new(),
            origin: RunOrigin::Replay { candidate: candidate.to_owned() },
            door: None,
            // A replay runs items the routine handled before, on purpose.
            confirm_repeat: true,
            client_request_id: None,
        };
        match start_runs(engine, new).await {
            Ok(runs) => made.extend(runs.into_iter().map(|run| run.id)),
            Err(StartError::Invalid(_)) => {
                tracing::info!(routine_id, "a past run the head no longer takes is not replayed")
            }
            Err(refused) => return Err(refused),
        }
    }
    tracing::info!(routine_id, runs = made.len(), "a playbook candidate is replayed");
    Ok(made)
}
