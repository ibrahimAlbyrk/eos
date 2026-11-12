//! The dashboard's row patches (`manager/daemon.ts`): a burst of worker and
//! pending changes becomes one `state:patch` event carrying just the changed
//! brief rows, so a tab does not read both lists again on every change.

use std::sync::Arc;

use eos_contracts::stream::topics;
use eos_runtime::Runtime;
use eos_runtime::access::Caller;
use eos_runtime::bus::Bus;
use eos_runtime::patches::{PatchOptions, PatchSink, RowChange, StatePatcher};
use eos_runtime::router::BoxFuture;
use eos_runtime::stream::StreamHub;
use serde::Serialize;
use serde_json::value::RawValue;

struct Stream {
    hub: StreamHub,
    bus: Bus,
}

#[derive(Serialize)]
struct Change<'a> {
    resource: &'a str,
    op: &'a str,
    data: &'a RawValue,
}

#[derive(Serialize)]
struct Patch<'a> {
    changes: Vec<Change<'a>>,
}

impl PatchSink for Stream {
    /// Nobody has the stream open: nothing is read.
    fn active(&self) -> bool {
        self.hub.size() > 0
    }

    fn push(&self, changes: Vec<RowChange>) -> BoxFuture<'_, ()> {
        let rows = changes.iter().filter_map(|change| {
            let data = serde_json::from_slice(&change.data).ok()?;
            Some(Change { resource: change.resource.as_str(), op: change.op.as_str(), data })
        });
        if let Ok(payload) = serde_json::to_vec(&Patch { changes: rows.collect() }) {
            self.bus.publish_raw(topics::STATE_PATCH, None, payload.into());
        }
        Box::pin(std::future::ready(()))
    }
}

/// Starts the patcher behind the stream's `state:patch`. Call inside the async runtime.
pub(crate) fn for_dashboard(runtime: &Runtime) -> StatePatcher {
    let (bus, hub) = (runtime.kernel.bus.clone(), runtime.kernel.stream.clone());
    let options = PatchOptions {
        workers: "/workers?brief=1".to_owned(),
        // Read as any page of the window reads them: no token, as today.
        ..PatchOptions::full_rows(Caller::UNTRUSTED)
    };
    StatePatcher::start(&bus, runtime.router.clone(), options, Arc::new(Stream { hub, bus: bus.clone() }))
}
