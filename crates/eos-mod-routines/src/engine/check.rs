//! What a handed-in result is read as, and the runs stored at the check
//! station (`checking`). A result goes from work straight to the gate
//! (`exec::hand_in`); no checker reads it. A run found waiting at the check
//! goes on to the gate the same way, its lead let go unless the gate sent
//! it back to work.

use std::sync::Arc;

use eos_contracts::ResultDoc;
use eos_core::Error;
use eos_core::store::StoredRunResult;
use eos_domain::routine::run::{Reason, RunState};

use super::{Engine, gate};

/// The result kind that says there is nothing worth sending (01 G20).
pub(crate) const NOTHING: &str = "nothing";

/// Hands a run found waiting at its check to the gate.
pub(crate) fn begin(engine: &Arc<Engine>, run_id: &str) {
    let (engine, run_id) = (engine.clone(), run_id.to_owned());
    tokio::spawn(async move {
        if let Err(error) = pass_on(&engine, &run_id).await {
            tracing::warn!(run_id, %error, "a run waiting at its check could not go on to the gate");
            // Let go first, so the lead is never held by a run that ended.
            release_lead(&engine, &run_id).await;
            if let Err(error) = super::fail(&engine, &run_id, Reason::Internal, None).await {
                tracing::error!(run_id, %error, "a run that could not go on to the gate could not be failed");
            }
        }
    });
}

async fn pass_on(engine: &Arc<Engine>, run_id: &str) -> Result<(), Error> {
    let untrusted = super::versions::untrusted_facts(engine).await?;
    let (id, now, job) = (run_id.to_owned(), engine.clock.now_ms(), engine.clone());
    let at_work = engine
        .store
        .write(move |tx, out| {
            let Some(run) = tx.runs().find(&id)?.filter(|run| run.state == RunState::Checking) else {
                return Ok(false);
            };
            gate::pass_in(&job, tx, out, &run, &untrusted, now)
        })
        .await?;
    if !at_work {
        release_lead(engine, run_id).await;
    }
    engine.wake.notify_one();
    tracing::info!(run_id, "a run waiting at its check went on to the gate");
    Ok(())
}

/// The result as parts: as the lead wrote it when it is one, else its body
/// as one part.
pub(crate) fn result_doc(result: &StoredRunResult) -> ResultDoc {
    let body: serde_json::Value = serde_json::from_str(&result.body).unwrap_or(serde_json::Value::Null);
    doc_of(&result.kind, body)
}

/// A result of `kind` whose body is `body`, as parts.
pub(crate) fn doc_of(kind: &str, body: serde_json::Value) -> ResultDoc {
    if let Ok(doc) = serde_json::from_value::<ResultDoc>(body.clone()) {
        return doc;
    }
    let text = match body {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    };
    let part = eos_contracts::Part { key: "body".into(), role: "text".into(), text, meta: Default::default() };
    ResultDoc { kind: kind.to_owned(), channel: String::new(), action: String::new(), parts: vec![part] }
}

/// The lead of `run_id` takes messages again.
pub(crate) async fn release_lead(engine: &Engine, run_id: &str) {
    let id = run_id.to_owned();
    let lead = engine.store.read(move |tx| Ok(tx.runs().find(&id)?.and_then(|run| run.lead_id))).await;
    if let Ok(Some(lead)) = lead {
        Engine::locked(&engine.held).remove(&lead);
    }
}

/// Whether Eos holds a lead's messages until it owes it a word.
pub(crate) fn holds(engine: &Engine, worker_id: &str) -> bool {
    Engine::locked(&engine.held).contains(worker_id)
}
