//! The domain `run`: a summary of each finished run of the last 30 days
//! (01 G37), no result and no transcript. A computer lists its own runs and
//! those other computers' summaries it keeps; the summaries of others are
//! shown read-only and never count toward a limit here.

use std::sync::Arc;

use eos_contracts::RunSummary;
use eos_core::net::sync::RecordSync;
use eos_core::store::{StoredRun, StoredSyncedRun, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use serde_json::Value;

use super::{refused, travels};
use crate::engine::Engine;
use crate::routes::run_summaries;

pub(crate) const RUN_SUMMARIES_KEPT_MS: i64 = 30 * 24 * 60 * 60_000;
/// The most summaries one computer lists.
const LISTED_MAX: i64 = 5_000;
/// Runs that only try a version stay where they ran.
const TRIAL: &str = "trial";

pub(crate) struct RunRecords(pub(crate) Arc<Engine>);

fn item(summary: &RunSummary) -> Result<SyncItem, Error> {
    let data = serde_json::to_value(summary).map_err(Error::storage)?;
    Ok(SyncItem { id: summary.id.clone(), data, updated_at: summary.ended_at.map(|at| at as f64) })
}

/// The summary of a run of this computer that travels.
fn own_summary(tx: &dyn Tx, run: &StoredRun, device: &str) -> Result<Option<RunSummary>, Error> {
    if run.ended_at.is_none() || run.kind == TRIAL || run.remote {
        return Ok(None);
    }
    if !tx.routines().find(&run.routine_id)?.is_some_and(|routine| travels(&routine)) {
        return Ok(None);
    }
    let mut summary = run_summaries(tx, [run])?.pop().ok_or_else(|| Error::storage("a run has a summary"))?;
    summary.needs_user = false;
    summary.device = Some(device.to_owned());
    Ok(Some(summary))
}

/// The summaries of other computers' runs of `routine_id` that ended since `since`.
pub(crate) fn synced_of(tx: &dyn Tx, routine_id: &str, since: i64, limit: i64) -> Result<Vec<RunSummary>, Error> {
    let rows = tx.synced_runs().ended_since(Some(routine_id), since, limit)?;
    Ok(rows.iter().filter_map(|row| serde_json::from_str(&row.summary_json).ok()).collect())
}

impl RunRecords {
    fn since(&self) -> i64 {
        self.0.clock.now_ms() - RUN_SUMMARIES_KEPT_MS
    }
}

impl RecordSync for RunRecords {
    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        let (since, device) = (self.since(), self.0.device.clone());
        Box::pin(self.0.store.read(move |tx| {
            let mut items = Vec::new();
            for run in tx.runs().ended_since(since, LISTED_MAX)? {
                if let Some(summary) = own_summary(tx, &run, &device)? {
                    items.push(item(&summary)?);
                }
            }
            for row in tx.synced_runs().ended_since(None, since, LISTED_MAX)? {
                let data: Value = serde_json::from_str(&row.summary_json).map_err(Error::storage)?;
                items.push(SyncItem { id: row.id, data, updated_at: Some(row.ended_at as f64) });
            }
            Ok(items)
        }))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        let (id, device) = (id.to_owned(), self.0.device.clone());
        Box::pin(self.0.store.read(move |tx| {
            if let Some(run) = tx.runs().find(&id)? {
                return own_summary(tx, &run, &device)?.as_ref().map(item).transpose();
            }
            match tx.synced_runs().find(&id)? {
                Some(row) => {
                    let data: Value = serde_json::from_str(&row.summary_json).map_err(Error::storage)?;
                    Ok(Some(SyncItem { id: row.id, data, updated_at: Some(row.ended_at as f64) }))
                }
                None => Ok(None),
            }
        }))
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        let (id, since) = (id.to_owned(), self.since());
        let parsed = eos_contracts::validate::parse::<RunSummary>(data).map_err(refused);
        Box::pin(async move {
            let summary = parsed?;
            let (Some(ended_at), Some(device)) = (summary.ended_at, summary.device.clone()) else {
                return Err(refused("a run's summary names when it ended and where"));
            };
            if summary.id != id {
                return Err(refused("the summary is of another run"));
            }
            let summary_json = serde_json::to_string(&summary).map_err(Error::storage)?;
            self.0
                .store
                .write(move |tx, _| {
                    // This computer's own run, or one past its days: nothing to keep.
                    if tx.runs().find(&id)?.is_some() || ended_at < since {
                        return Ok(());
                    }
                    let routine_id = summary.routine_id;
                    tx.synced_runs().put(&StoredSyncedRun { id, routine_id, device, ended_at, summary_json })
                })
                .await
        })
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        let id = id.to_owned();
        Box::pin(self.0.store.write(move |tx, _| tx.synced_runs().delete(&id)))
    }
}
