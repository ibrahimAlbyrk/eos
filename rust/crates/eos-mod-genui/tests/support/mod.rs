//! The feature over the real store and the real settings files, with fakes
//! for everything that reaches outside the process.

#![allow(dead_code)]

use std::sync::Arc;

use eos_config::{ConfigFile, SettingsFile};
use eos_core::shell::Location;
use eos_domain::config::Env;
use eos_mod_genui::{GenuiModule, GenuiParts};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request, Response};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClock, FakeGeocoder, FakeMap, FakeMedia, FakePlaceSearch, SeqIds, TempStore};
use serde_json::Value;

pub(crate) const SANDBOX: &str = "/sandbox";

pub(crate) struct Harness {
    pub(crate) temp: TempStore,
    pub(crate) runtime: Runtime,
    pub(crate) module: Arc<GenuiModule>,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) media: Arc<FakeMedia>,
    pub(crate) map: Arc<FakeMap>,
    pub(crate) geocoder: Arc<FakeGeocoder>,
    pub(crate) places: Arc<FakePlaceSearch>,
    pub(crate) settings: Arc<SettingsFile>,
    pub(crate) config: Arc<ConfigFile>,
}

#[derive(Default)]
pub(crate) struct Fakes {
    pub(crate) media: FakeMedia,
    pub(crate) map: FakeMap,
    pub(crate) geocoder: FakeGeocoder,
    pub(crate) places: FakePlaceSearch,
    pub(crate) location: Option<Arc<dyn Location>>,
}

impl Harness {
    /// On the wire fixtures' invented rows: `w-CHAT` is a focused session,
    /// `o-ORCH` an orchestrator, `w-KID1` one of its workers.
    pub(crate) async fn start(fakes: Fakes) -> Self {
        let clock = Arc::new(FakeClock::new());
        let ids = Arc::new(SeqIds::new());
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
        let temp = TempStore::seeded_on_bus(SANDBOX, &kernel.bus);
        let settings = Arc::new(SettingsFile::new(temp.home.join("settings.json")));
        let config = Arc::new(ConfigFile::load(temp.home.path(), Env::default(), true));
        let (media, map) = (Arc::new(fakes.media), Arc::new(fakes.map));
        let (geocoder, places) = (Arc::new(fakes.geocoder), Arc::new(fakes.places));
        let module = Arc::new(GenuiModule::new(GenuiParts {
            store: temp.port(),
            settings: settings.clone(),
            config: config.clone(),
            clock: clock.clone(),
            ids,
            bus: kernel.bus.clone(),
            media: media.clone(),
            map: map.clone(),
            geocoder: geocoder.clone(),
            place_search: places.clone(),
            location: fakes.location,
        }));
        let runtime = Runtime::build(kernel, vec![module.clone()], Arc::new(AllPluginsOn)).expect("composes");
        assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
        runtime.lifecycle.start().await.expect("started");
        Self { temp, runtime, module, clock, media, map, geocoder, places, settings, config }
    }

    pub(crate) async fn send(&self, req: Request) -> Answer {
        let response = self.runtime.router.handle(req).await;
        self.runtime.kernel.bus.flush().await;
        Answer::read(response).await
    }

    /// As the dashboard (with the ui-token).
    pub(crate) async fn user(&self, method: Method, target: &str, body: Option<Value>) -> Answer {
        self.send(with_body(Request::new(method, target, Caller::DASHBOARD), body)).await
    }

    /// As a local caller without the token that says which agent it is.
    pub(crate) async fn agent(&self, agent: &str, method: Method, target: &str, body: Option<Value>) -> Answer {
        let req = Request::new(method, target, Caller::UNTRUSTED).header("x-eos-agent-id", agent);
        self.send(with_body(req, body)).await
    }

    /// As a local caller with neither the token nor an agent id.
    pub(crate) async fn anyone(&self, method: Method, target: &str, body: Option<Value>) -> Answer {
        self.send(with_body(Request::new(method, target, Caller::UNTRUSTED), body)).await
    }
}

fn with_body(req: Request, body: Option<Value>) -> Request {
    match body {
        Some(body) => req.body(serde_json::to_vec(&body).expect("json")),
        None => req,
    }
}

#[derive(Debug)]
pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) bytes: Vec<u8>,
}

impl Answer {
    async fn read(response: Response) -> Self {
        let status = response.status;
        let headers = response.headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
        let bytes = response.body.collect().await.expect("a body").to_vec();
        Self { status, headers, bytes }
    }

    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    pub(crate) fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }

    pub(crate) fn error(&self) -> String {
        self.json()["error"].as_str().unwrap_or_default().to_owned()
    }
}
