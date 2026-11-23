//! Playbook replays (01 G50): memory checks a rewritten playbook by running
//! the routine again on past runs' items with the candidate in its pack.
//! Each replay is a trial of the routine's head (kind `trial`, origin
//! `replay`, the candidate as its reference) that shows its result in
//! `run_results` and sends nothing; its notes earn no credit. Only an
//! active routine is replayed, after every run the user asked for.

use std::sync::Arc;

use eos_contracts::{ItemRef, ResultMode, RunInput};
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
    let items: Vec<ItemRef> = engine
        .store
        .read(move |tx| {
            let mut items = Vec::new();
            for id in &ids {
                let Some(run) = tx.runs().find(id)?.filter(|run| run.routine_id == routine) else { continue };
                let input: Option<RunInput> = serde_json::from_str(&run.input).ok();
                items.extend(input.and_then(|input| input.item));
            }
            Ok(items)
        })
        .await?;
    // One start a past run: a routine may take one item at a time.
    let mut made = Vec::with_capacity(items.len());
    for item in items {
        let new = NewRun {
            routine_id: routine_id.to_owned(),
            version: None,
            input: RunInput {
                item: Some(item),
                items: None,
                trigger: None,
                options: Default::default(),
                note: None,
                result: ResultMode::ShowOnly,
                at: None,
            },
            items: Vec::new(),
            origin: RunOrigin::Replay { candidate: candidate.to_owned() },
            door: None,
            // A replay runs items the routine handled before, on purpose.
            confirm_repeat: true,
            client_request_id: None,
        };
        made.extend(start_runs(engine, new).await?.into_iter().map(|run| run.id));
    }
    tracing::info!(routine_id, runs = made.len(), "a playbook candidate is replayed");
    Ok(made)
}
