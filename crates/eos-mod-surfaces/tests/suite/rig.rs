//! The module over the real store, with a routine's surface stored by the
//! test.

use std::sync::Arc;

use eos_core::store::{StoredIssue, StoredSurface, StoredSurfaceVersion};
use eos_mod_surfaces::{SurfacesModule, SurfacesParts};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_surface::{IssueKind, IssueStatus, Level, MadeBy, Place, Role, VersionStatus};
use eos_testkit::{FakeClock, FakeSettings, TempStore};
use serde_json::Value;

pub(crate) struct Rig {
    pub(crate) runtime: Runtime,
    pub(crate) temp: TempStore,
    pub(crate) settings: Arc<FakeSettings>,
}

impl Rig {
    pub(crate) async fn new() -> Self {
        let kernel = Kernel::new(KernelOptions::default());
        let temp = TempStore::on_bus(&kernel.bus);
        let settings = Arc::new(FakeSettings::default());
        let module = Arc::new(SurfacesModule::new(SurfacesParts {
            store: temp.port(),
            clock: Arc::new(FakeClock::at(5_000)),
            settings: settings.clone(),
        }));
        let runtime = Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        runtime.lifecycle.start().await.expect("starts");
        Self { runtime, temp, settings }
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
