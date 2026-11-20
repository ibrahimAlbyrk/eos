//! A rule the user stated in a chat ("from now on use pnpm here") goes to
//! About you at once, with no model: scoped to the chat's project unless it
//! says it holds everywhere. Where it was said is kept in `mem_stated`,
//! never in the memory file, whose format older versions read.

use std::sync::Arc;

use eos_core::profile::{StatedRule, UserMemoryKeeper};
use eos_core::store::{Store, StoredMoment, StoredStated};
use eos_core::{Clock, Error};
use eos_domain::experience::moments::says_everywhere;

/// Keeps `text`, said in `moment`, and marks the moment reflected. Answers
/// the kept memory's id.
pub async fn keep(
    keeper: &dyn UserMemoryKeeper,
    store: &Arc<dyn Store>,
    clock: &dyn Clock,
    moment: &StoredMoment,
    text: &str,
    project: Option<String>,
) -> Result<String, Error> {
    let project = project.filter(|_| !says_everywhere(text));
    let kept = keeper.keep_stated(StatedRule { text: text.to_owned(), project })?;
    let stated = StoredStated {
        memory_id: kept.memory_id.clone(),
        worker_id: moment.worker_id.clone(),
        row_id: moment.row_from,
        at: clock.now_ms(),
    };
    let (moment_id, at) = (moment.id.clone(), stated.at);
    store
        .write(move |tx, _| {
            tx.mem_book().put_stated(&stated)?;
            tx.mem_moments().finish(&moment_id, "reflected", None, at)
        })
        .await?;
    tracing::info!(moment = %moment.id, duplicate = kept.duplicate, "memory: kept a stated rule");
    Ok(kept.memory_id)
}
