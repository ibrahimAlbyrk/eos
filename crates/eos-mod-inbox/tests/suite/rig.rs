//! The module over the real store, with the questions agents wait on and the
//! memories about the user given by the test.

use std::sync::{Arc, Mutex};

use eos_contracts::UserMemory;
use eos_core::agent::OpenQuestions;
use eos_core::profile::UserMemoryReader;
use eos_core::routine::{Confirmed, RoutineControl};
use eos_core::store::{NewPending, StoredItem};
use eos_domain::inbox::ItemKind;
use eos_inbox::{NewItem, Opening, RunQuestionParts, RunQuestions, open_in};
use eos_mod_inbox::{InboxModule, InboxParts};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::relay::FakePhoneNotify;
use eos_testkit::{
    FakeChannels, FakeClock, FakeConfig, FakeDockBadge, FakeRoutineControl, FakeRunOutcomes, FakeSleeper, FakeTimeZone,
    FakeUser, SeqIds, TempStore,
};
use serde_json::{Value, json};

#[derive(Default)]
pub(crate) struct Waiting {
    askers: Mutex<Vec<String>>,
    memories: Mutex<Vec<Arc<UserMemory>>>,
}

impl OpenQuestions for Waiting {
    fn has_open(&self, worker_id: &str) -> bool {
        self.open_askers().iter().any(|asker| asker == worker_id)
    }

    fn open_askers(&self) -> Vec<String> {
        self.askers.lock().expect("unpoisoned").clone()
    }
}

impl UserMemoryReader for Waiting {
    fn list(&self) -> Vec<Arc<UserMemory>> {
        self.memories.lock().expect("unpoisoned").clone()
    }

    fn search(&self, _query: &str, _project: Option<&str>, _limit: usize) -> Vec<Arc<UserMemory>> {
        Vec::new()
    }
}

/// What the user confirmed of routine `rt-1`: a review on its pull request.
fn pull_requests() -> Confirmed {
    let goes_to = serde_json::from_value(json!([{"id": "pr", "kind": "item_place", "channel": "github"}]));
    let freedom = serde_json::from_value(json!({"rung": "draft"}));
    Confirmed { freedom: freedom.expect("a freedom"), goes_to: goes_to.expect("recipients") }
}

pub(crate) struct Rig {
    pub(crate) runtime: Runtime,
    pub(crate) temp: TempStore,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) waiting: Arc<Waiting>,
    /// What the routines' control answers.
    pub(crate) control: Arc<FakeRoutineControl>,
    /// The number on the Dock icon.
    pub(crate) badge: Arc<FakeDockBadge>,
    /// How a run's sessions ask the user.
    pub(crate) questions: RunQuestions,
    /// The waits of the module's loops.
    pub(crate) sleeper: Arc<FakeSleeper>,
    ids: Arc<SeqIds>,
}

impl Rig {
    pub(crate) async fn new() -> Self {
        let clock = Arc::new(FakeClock::at(1_000_000));
        let waiting = Arc::new(Waiting::default());
        let kernel = Kernel::new(KernelOptions::default());
        let temp = TempStore::on_bus(&kernel.bus);
        let control = Arc::new(FakeRoutineControl::new().confirming("rt-1", pull_requests()));
        let badge = Arc::new(FakeDockBadge::new());
        let sleeper = Arc::new(FakeSleeper::default());
        let questions = RunQuestions::new(RunQuestionParts {
            store: temp.port(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
            wrapped: Arc::new(FakeUser::default()),
        });
        let routines: Arc<dyn RoutineControl> = control.clone();
        questions.attach(&routines);
        let module = Arc::new(InboxModule::new(InboxParts {
            store: temp.port(),
            clock: clock.clone(),
            bus: kernel.bus.clone(),
            questions: waiting.clone(),
            memories: waiting.clone(),
            waiters: questions.waiters(),
            delivery: eos_inbox::delivery::DeliveryParts {
                store: temp.port(),
                clock: clock.clone(),
                sleeper: sleeper.clone(),
                ids: Arc::new(SeqIds::new()),
                zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
                channels: Arc::new(FakeChannels::new()),
                control: control.clone(),
                outcomes: Arc::new(FakeRunOutcomes::new()),
                wake: Arc::new(tokio::sync::Notify::new()),
            },
            config: Arc::new(FakeConfig::new(json!({}))),
            phone: Arc::new(FakePhoneNotify::new()),
            badge: badge.clone(),
        }));
        let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        runtime.lifecycle.start().await.expect("starts");
        runtime.lifecycle.ready().await.expect("ready");
        Self { runtime, temp, clock, waiting, control, badge, questions, sleeper, ids: Arc::new(SeqIds::new()) }
    }

    pub(crate) async fn ask_as(&self, caller: Caller, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::new(method, path, caller);
        if let Some(body) = body {
            request = request.body(body.to_string());
        }
        let response = self.runtime.router.handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    pub(crate) async fn ask(&self, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        self.ask_as(Caller::DASHBOARD, method, path, body).await
    }

    /// Opens an item as a producer would; time moves on a millisecond after.
    pub(crate) async fn open(&self, new: NewItem) -> StoredItem {
        let (now, ids) = (self.clock.advance(1), self.ids.clone());
        let item = self
            .temp
            .port()
            .write(move |tx, out| {
                let (zone, control) = (FakeTimeZone::new("UTC", 0), FakeRoutineControl::new());
                let at = Opening { now, ids: ids.as_ref(), zone: &zone, control: &control };
                open_in(tx, out, &at, new)
            })
            .await;
        item.expect("opens")
    }

    /// `worker_id` works for run `rn-1` of routine `rt-1`.
    pub(crate) fn run_worker(&self, worker_id: &str) {
        self.temp.exec(&format!(
            "INSERT OR IGNORE INTO runs (id, routine_id, version_id, kind, origin, input, state, priority, device, \
             created_at, updated_at) VALUES ('rn-1', 'rt-1', 'rv-1', 'standing', 'hand', '{{}}', 'running', 0, 'd', 1, 1); \
             INSERT INTO routine_sessions (worker_id, routine_id, run_id, role, created_at) \
             VALUES ('{worker_id}', 'rt-1', 'rn-1', 'solo', 1);"
        ));
    }

    /// An open permission ask of `worker_id`.
    pub(crate) async fn ask_permission(&self, id: &str, worker_id: &str, created_at: i64) {
        let pending = NewPending {
            id: id.into(),
            worker_id: worker_id.into(),
            tool_name: "Bash".into(),
            input: r#"{"command":"cargo test"}"#.into(),
            tool_use_id: Some("toolu_1".into()),
            created_at,
            expires_at: created_at + 86_400_000,
        };
        self.temp.port().write(move |tx, _| tx.pending().insert(&pending)).await.expect("writes");
    }

    pub(crate) fn suggest(&self, id: &str, created_at: f64) {
        let memory: UserMemory = serde_json::from_value(json!({
            "id": id, "text": "Prefers short reviews", "category": "work-style", "scope": {"kind": "global"},
            "tier": "always", "status": "suggested", "source": {"kind": "user"}, "rev": 2,
            "createdAt": created_at, "updatedAt": created_at
        }))
        .expect("a memory");
        self.waiting.memories.lock().expect("unpoisoned").push(Arc::new(memory));
    }

    pub(crate) fn question_from(&self, worker_id: &str) {
        self.waiting.askers.lock().expect("unpoisoned").push(worker_id.to_owned());
    }
}

/// An item of `kind` for `routine`.
pub(crate) fn new_item(kind: ItemKind, routine: &str) -> NewItem {
    NewItem {
        kind,
        producer: "routines".into(),
        routine_id: Some(routine.into()),
        run_id: None,
        subject_key: None,
        title: "Review of #482".into(),
        summary: "Two comments".into(),
        payload: json!({ "doc": {} }),
        by_hand: false,
    }
}
