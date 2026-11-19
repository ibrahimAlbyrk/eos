//! The module over the real store, behind a store that can fail a write as
//! a crash would, with an intake whose admissions count only once saved.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{Fact, Facts, RoutineKind, RoutineState};
use eos_core::routine::{Admission, AdmitOutcome, RoutineLoad, RoutineTriggers, RunIntake};
use eos_core::signals::{PollPage, SignalDraft};
use eos_core::store::{Outbox, ReadJob, Store, StoredSignalSource, Tx, WriteJob};
use eos_core::{BoxFuture, Error};
use eos_domain::signals::key::capability_scope;
use eos_mod_signals::{SignalsModule, SignalsParts, SoloRunner};
use eos_runtime::module::Module;
use eos_testkit::{FakeClock, FakeRoutineDirectory, FakeSignalSources, FakeZoneRules, SeqIds, TempStore};
use serde_json::{Value, json};

pub(crate) const SOURCE_ID: &str = "src-0a1b2c3d4e5f";
pub(crate) const REPO: &str = "acme/game";
/// Committed admissions are announced on this topic by [`SavedIntake`].
pub(crate) const ADMITTED: &str = "test:admitted";

/// The real store; the write numbered `fail_at` (from 0) runs, then fails
/// as if Eos stopped before it was saved.
pub(crate) struct Flaky {
    inner: Arc<dyn Store>,
    writes: AtomicUsize,
    fail_at: Mutex<Option<usize>>,
    failed: Arc<AtomicBool>,
}

impl Flaky {
    pub(crate) fn new(inner: Arc<dyn Store>, fail_at: Option<usize>) -> Self {
        Self { inner, writes: AtomicUsize::new(0), fail_at: Mutex::new(fail_at), failed: Arc::default() }
    }

    /// Waits until the write it fails has failed.
    pub(crate) async fn crashed(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !self.failed.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the write failed");
    }
}

impl Store for Flaky {
    fn run_read(&self, job: ReadJob) -> BoxFuture<'_, Result<(), Error>> {
        self.inner.run_read(job)
    }

    fn run_write(&self, job: WriteJob) -> BoxFuture<'_, Result<(), Error>> {
        let n = self.writes.fetch_add(1, Ordering::SeqCst);
        let fail = *self.fail_at.lock().expect("unpoisoned") == Some(n);
        let failed = self.failed.clone();
        self.inner.run_write(Box::new(move |tx, out| {
            job(tx, out)?;
            if fail {
                failed.store(true, Ordering::SeqCst);
                return Err(Error::Storage("stopped before the write was saved".into()));
            }
            Ok(())
        }))
    }
}

/// Queues every admission as `rn-<signal>-<routine>` and says so in the
/// write's outbox, so only saved admissions are counted. The admission
/// numbered `fail_at` fails its write.
pub(crate) struct SavedIntake {
    calls: AtomicUsize,
    fail_at: Option<usize>,
}

impl SavedIntake {
    pub(crate) fn new(fail_at: Option<usize>) -> Self {
        Self { calls: AtomicUsize::new(0), fail_at }
    }
}

impl RunIntake for SavedIntake {
    fn admit(&self, _tx: &dyn Tx, out: &mut Outbox, admission: &Admission) -> Result<AdmitOutcome, Error> {
        if Some(self.calls.fetch_add(1, Ordering::SeqCst)) == self.fail_at {
            return Err(Error::Storage("the run could not be queued".into()));
        }
        out.push(ADMITTED, &json!({ "routine": admission.routine_id, "signal": admission.signal_id }));
        Ok(AdmitOutcome::Queued { run_id: format!("rn-{}-{}", admission.signal_id, admission.routine_id) })
    }

    fn supersede(&self, _tx: &dyn Tx, _out: &mut Outbox, _run_id: &str) -> Result<bool, Error> {
        Ok(false)
    }

    fn load(&self, _tx: &dyn Tx, _routine_id: &str, _since: i64) -> Result<RoutineLoad, Error> {
        Ok(RoutineLoad { queued: 0, started_since: 0, active: 0 })
    }

    fn finished_after(
        &self,
        _tx: &dyn Tx,
        _routine_id: &str,
        _after_seq: i64,
        _limit: i64,
    ) -> Result<Vec<eos_core::routine::FinishedRun>, Error> {
        Ok(Vec::new())
    }
}

/// A routine reading [`REPO`]'s pull requests for `events`, with `rule`.
pub(crate) fn routine(id: &str, state: RoutineState, events: &[&str], rule: Option<Value>) -> RoutineTriggers {
    let when = json!({ "on": [{ "source": "github.pulls", "scope": { "repo": REPO }, "events": events }] });
    let which = rule.map_or_else(|| json!({}), |rule| json!({ "rule": rule }));
    RoutineTriggers {
        id: id.into(),
        version: format!("rv-{id}"),
        state,
        kind: RoutineKind::Standing,
        when: serde_json::from_value(when).expect("a When"),
        which: serde_json::from_value(which).expect("a Which"),
    }
}

/// Pull request `n` at `sha`, with its facts.
pub(crate) fn pull(n: u64, sha: &str, kind: &str, draft: bool, paths: &[&str]) -> SignalDraft {
    let mut facts = Facts::new();
    facts.insert("repo".into(), Fact::Text(REPO.into()));
    facts.insert("draft".into(), Fact::Bool(draft));
    facts.insert("paths".into(), Fact::List(paths.iter().map(|path| (*path).to_owned()).collect()));
    let key = format!("github:pr:{REPO}#{n}");
    SignalDraft {
        key: format!("{key}@{sha}"),
        subject: key.clone(),
        version: Some(sha.into()),
        kind: kind.into(),
        occurred_at: 1_000,
        facts,
        item: json!({ "kind": "github.pull_request", "key": format!("{key}@{sha}"), "version": sha, "untrusted": true }),
    }
}

pub(crate) fn page(items: Vec<SignalDraft>, cursor: Value) -> PollPage {
    PollPage { items, cursor, more: false, baseline: false, poll_after_ms: None, retry_at: None }
}

/// The source row every routine of [`REPO`] shares.
pub(crate) fn add_source(temp: &TempStore) {
    let scope = [("repo".to_owned(), REPO.to_owned())].into_iter().collect();
    let (scope_json, scope_hash) = capability_scope("github.pulls", &scope);
    let source = StoredSignalSource {
        id: SOURCE_ID.into(),
        kind: "capability".into(),
        source: Some("github.pulls".into()),
        scope_json,
        scope_hash,
        cursor_json: None,
        state: "active".into(),
        error_kind: None,
        failures: 0,
        interval_ms: 60_000,
        last_poll_at: None,
        next_poll_at: None,
        last_signal_at: None,
        catch_up_json: None,
        stopped_at: None,
        created_at: 1,
        updated_at: 1,
    };
    temp.store.write_blocking(move |tx, _| tx.signal_sources().insert(&source)).expect("the source");
}

/// `(signal, routine, decision, reason, run)`.
pub(crate) type Route = (i64, String, String, Option<String>, Option<String>);

pub(crate) struct Bench {
    pub(crate) temp: TempStore,
    pub(crate) directory: Arc<FakeRoutineDirectory>,
}

impl Bench {
    pub(crate) fn new(routines: Vec<RoutineTriggers>) -> Self {
        let temp = TempStore::new();
        add_source(&temp);
        Self { temp, directory: Arc::new(FakeRoutineDirectory::new(routines)) }
    }

    /// The module over the store as `store` lets it write.
    pub(crate) fn module(&self, store: Arc<dyn Store>, intake: Arc<dyn RunIntake>, autostart: bool) -> SignalsModule {
        SignalsModule::new(SignalsParts {
            store,
            clock: Arc::new(FakeClock::at(5_000)),
            ids: Arc::new(SeqIds::new()),
            zones: Arc::new(FakeZoneRules::new()),
            sources: Arc::new(FakeSignalSources::new()),
            runner: Arc::new(SoloRunner::new("dev-1")),
            intake,
            directory: self.directory.clone(),
            bus: eos_runtime::Kernel::new(eos_runtime::KernelOptions::default()).bus,
            autostart,
        })
    }

    pub(crate) fn received(&self) -> i64 {
        self.temp.count("SELECT count(*) FROM signals WHERE state = 'received'")
    }

    /// Starts `module`'s router and waits until nothing waits to be routed.
    pub(crate) async fn route(&self, module: &SignalsModule) {
        module.after_ready().await.expect("ready");
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.received() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("every signal is routed");
    }

    /// Every route, in order.
    pub(crate) fn routes(&self) -> Vec<Route> {
        let ids: Vec<i64> = self
            .temp
            .store
            .read_blocking(|tx| {
                let mut ids = Vec::new();
                let mut id = 1;
                while let Some(signal) = tx.signals().find(id)? {
                    ids.push(signal.id);
                    id += 1;
                }
                Ok(ids)
            })
            .expect("reads");
        let mut routes = Vec::new();
        for id in ids {
            let found = self.temp.store.read_blocking(move |tx| tx.signal_routes().by_signal(id)).expect("reads");
            routes.extend(found.into_iter().map(|route| {
                (route.signal_id, route.routine_id, route.decision.as_str().to_owned(), route.reason, route.run_id)
            }));
        }
        routes
    }

    /// The admissions saved, as `(routine, signal)`.
    pub(crate) fn admitted(&self) -> Vec<(String, i64)> {
        let announced = self.temp.announced.list();
        let saved = announced.into_iter().filter(|(topic, _)| *topic == ADMITTED);
        saved
            .map(|(_, payload)| {
                let value: Value = serde_json::from_str(&payload).expect("JSON");
                (value["routine"].as_str().unwrap_or_default().to_owned(), value["signal"].as_i64().unwrap_or_default())
            })
            .collect()
    }
}
