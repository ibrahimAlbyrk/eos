//! The module over the real store, with a routine's surface stored by the
//! test.

use std::sync::{Arc, Mutex};

use eos_contracts::ActionClass;
use eos_core::inbox::ActionDecision;
use eos_core::store::{StoredIssue, StoredSurface, StoredSurfaceVersion};
use eos_mod_surfaces::{SurfacesModule, SurfacesParts};
use eos_runtime::access::Caller;
use eos_runtime::actions::{
    ActionCall, ActionDecl, ActionFailure, ActionHandler, ActionScope, QueryCall, QueryDecl, QueryHandler, no_args,
};
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::router::{AllPluginsOn, BoxFuture};
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_surface::{Field, IssueKind, IssueStatus, Level, MadeBy, Place, Role, Type, VersionStatus};
use eos_testkit::{
    FakeActionGate, FakeClock, FakeExperienceFeedback, FakeSettings, FakeSurfaceImages, FakeTimeZone, FakeTrash,
    FakeUserProfileStore, FakeViewCards, SeqIds, TempStore,
};
use serde_json::{Value, json};

pub(crate) struct Rig {
    pub(crate) runtime: Runtime,
    pub(crate) module: Arc<SurfacesModule>,
    pub(crate) temp: TempStore,
    pub(crate) settings: Arc<FakeSettings>,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) gate: Arc<FakeActionGate>,
    pub(crate) cards: Arc<FakeViewCards>,
    pub(crate) images: Arc<FakeSurfaceImages>,
    /// Every call the test's actions heard, in order.
    pub(crate) heard: Arc<Mutex<Vec<ActionCall>>>,
    /// Every read of the test's query, in order.
    pub(crate) read: Arc<Mutex<Vec<QueryCall>>>,
    pub(crate) feedback: Arc<FakeExperienceFeedback>,
    /// Where removed surfaces' folders go, and `surfaces/` itself.
    pub(crate) trash: Arc<FakeTrash>,
    pub(crate) dir: tempfile::TempDir,
}

/// A feature with actions of every class, which records what it is called with.
struct Probe(Arc<Mutex<Vec<ActionCall>>>);

impl ActionHandler for Probe {
    fn run(&self, call: ActionCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        let failing = call.action_id == "probe.fails";
        self.0.lock().expect("heard").push(call.clone());
        Box::pin(async move {
            if failing { Err(ActionFailure::new("broken", "It broke")) } else { Ok(json!({"echo": call.args})) }
        })
    }
}

struct ProbeModule(Arc<Mutex<Vec<ActionCall>>>, Arc<Mutex<Vec<QueryCall>>>);

/// Answers how many it heard before, and fails once told to.
struct Counter(Arc<Mutex<Vec<QueryCall>>>);

impl QueryHandler for Counter {
    fn read(&self, call: QueryCall) -> BoxFuture<'_, Result<Value, ActionFailure>> {
        let mut read = self.0.lock().expect("read");
        read.push(call.clone());
        let count = read.len();
        Box::pin(async move {
            if call.args["of"] == "broken" {
                Err(ActionFailure::new("broken", "It broke"))
            } else {
                Ok(json!({"count": count}))
            }
        })
    }
}

impl Module for ProbeModule {
    fn id(&self) -> &'static str {
        "probe"
    }

    fn direct_actions(&self) -> Vec<ActionDecl> {
        let decl = |id, class, scope, args| ActionDecl {
            id,
            title: "Probe",
            args,
            class,
            scope,
            handler: Arc::new(Probe(self.0.clone())),
        };
        let item = Type::Object {
            fields: vec![Field::required("item", Type::Url), Field::optional("note", Type::Text { max: 20 })],
        };
        vec![
            decl("probe.with", ActionClass::WriteLocal, ActionScope::OwnerRoutine, item),
            decl("probe.again", ActionClass::WriteLocal, ActionScope::OwnerRoutine, no_args()),
            decl("probe.fails", ActionClass::WriteLocal, ActionScope::OwnerRoutine, no_args()),
            decl("probe.global", ActionClass::Read, ActionScope::Any, no_args()),
            decl("probe.erase", ActionClass::Irreversible, ActionScope::OwnerRoutine, no_args()),
        ]
    }

    fn surface_queries(&self) -> Vec<QueryDecl> {
        vec![QueryDecl {
            id: "probe.count",
            title: "How many",
            args: Type::Object { fields: vec![Field::optional("of", Type::Text { max: 20 })] },
            scope: ActionScope::Any,
            topics: &["probe:change"],
            handler: Arc::new(Counter(self.1.clone())),
        }]
    }
}

impl Rig {
    pub(crate) async fn new() -> Self {
        let kernel = Kernel::new(KernelOptions::default());
        let temp = TempStore::on_bus(&kernel.bus);
        let settings = Arc::new(FakeSettings::default());
        let clock = Arc::new(FakeClock::at(5_000));
        let gate = Arc::new(FakeActionGate::new(ActionDecision::Run));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let cards = Arc::new(FakeViewCards::new().hearing("The user answered: Ship it"));
        let images = Arc::new(
            FakeSurfaceImages::new()
                .with("https://example.com/replays.jpg", &"a".repeat(64))
                .with("/runs/rn-1/chart.png", &"b".repeat(64)),
        );
        let profile = Arc::new(FakeUserProfileStore::default());
        let feedback = Arc::new(FakeExperienceFeedback::new());
        let dir = tempfile::tempdir().expect("a folder");
        let trash = Arc::new(FakeTrash::new(dir.path().join("trash")));
        let mut me = eos_domain::user_profile::empty_user_profile();
        me.identity.call_name = "Ibrahim".into();
        eos_core::store::UserProfileStore::put(profile.as_ref(), me).expect("a profile");
        let module = Arc::new(SurfacesModule::new(SurfacesParts {
            store: temp.port(),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
            settings: settings.clone(),
            actions: kernel.actions.clone(),
            gate: gate.clone(),
            cards: cards.clone(),
            images: images.clone(),
            zone: Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)),
            profile,
            feedback: feedback.clone(),
        }));
        let read = Arc::new(Mutex::new(Vec::new()));
        let probe = Arc::new(ProbeModule(heard.clone(), read.clone()));
        let runtime = Runtime::build(kernel, vec![module.clone(), probe], Arc::new(AllPluginsOn)).expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        runtime.lifecycle.start().await.expect("starts");
        Self { runtime, module, temp, settings, clock, gate, cards, images, heard, read, feedback, trash, dir }
    }

    /// The author the routines feature holds, over this rig's store and folders.
    pub(crate) fn author(&self) -> eos_mod_surfaces::SurfaceAuthor {
        eos_mod_surfaces::SurfaceAuthor::new(
            self.temp.port(),
            self.clock.clone(),
            Arc::new(SeqIds::new()),
            self.trash.clone(),
            self.dir.path().join("surfaces"),
        )
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

    /// A route that answers text: its status, headers and body.
    pub(crate) async fn fetch(
        &self,
        router: &eos_runtime::router::Router,
        path: &str,
    ) -> (u16, Vec<(String, String)>, String) {
        let response = router.handle(Request::new(Method::Get, path, Caller::DASHBOARD)).await;
        let status = response.status;
        let headers = response.headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let bytes = response.body.collect().await.expect("a body");
        (status, headers, String::from_utf8_lossy(&bytes).into_owned())
    }

    pub(crate) async fn ask(&self, method: Method, path: &str, body: Option<Value>) -> (u16, Value) {
        self.ask_as(Caller::DASHBOARD, method, path, body).await
    }

    /// Routine `routine` named `name`, with run `run` of `kind` whose lead is `worker`.
    pub(crate) fn run_worker(&self, routine: &str, name: &str, run: &str, kind: &str, worker: &str) {
        self.temp.exec(&format!(
            "INSERT OR IGNORE INTO routines (id, slug, name, kind, state, origin, created_at, updated_at, changed_at) \
             VALUES ('{routine}', '{routine}', '{name}', 'standing', 'active', 'hand', 1, 1, 1); \
             INSERT INTO runs (id, routine_id, version_id, kind, origin, input, state, priority, device, \
             created_at, updated_at) VALUES ('{run}', '{routine}', 'rv-1', '{kind}', 'hand', '{{}}', 'running', 0, 'd', 1, 1); \
             INSERT INTO routine_sessions (worker_id, routine_id, run_id, role, created_at) \
             VALUES ('{worker}', '{routine}', '{run}', 'solo', 1);"
        ));
    }

    /// Stores surfaces, versions and issues as a run would have left them.
    pub(crate) async fn seed(
        &self,
        surfaces: Vec<StoredSurface>,
        versions: Vec<StoredSurfaceVersion>,
        issues: Vec<StoredIssue>,
    ) {
        self.temp
            .port()
            .write(move |tx, _| {
                for s in &surfaces {
                    tx.surfaces().put(s)?;
                }
                for v in &versions {
                    tx.surface_versions().put(v)?;
                }
                for i in &issues {
                    tx.surface_issues().put(i)?;
                }
                Ok(())
            })
            .await
            .expect("seeds");
    }
}

pub(crate) fn surface(id: &str, routine: &str, level: Level, place: Place, created_at: i64) -> StoredSurface {
    StoredSurface {
        id: id.into(),
        routine_id: routine.into(),
        level,
        place,
        role: Role::Result,
        title: "Overnight mail".into(),
        current_version: None,
        candidate_version: None,
        needs_redesign_json: None,
        archived_at: None,
        created_at,
        updated_at: created_at,
    }
}

pub(crate) fn version(surface_id: &str, version: i64, status: VersionStatus) -> StoredSurfaceVersion {
    StoredSurfaceVersion {
        surface_id: surface_id.into(),
        version,
        status,
        base_version: (version > 1).then(|| version - 1),
        made_by: MadeBy::Designer,
        run_id: Some("rn-1".into()),
        note: format!("design {version}"),
        body_json: r#"{"template":"<p part=\"a\">{title}</p>"}"#.into(),
        body_bytes: 40,
        checks_json: r#"{"passed":true}"#.into(),
        created_at: version * 10,
        kept_at: (status == VersionStatus::Kept).then_some(version * 10 + 1),
    }
}

pub(crate) fn issue(id: &str, surface_id: &str) -> StoredIssue {
    StoredIssue {
        id: id.into(),
        surface_id: surface_id.into(),
        seq: Some(1),
        run_id: Some("rn-1".into()),
        version: None,
        kind: IssueKind::View,
        status: IssueStatus::Ready,
        body_json: "{}".into(),
        rev: 1,
        images_json: "[]".into(),
        trial: false,
        kept: false,
        created_at: 100,
        updated_at: 100,
    }
}
