//! `POST /api/model-catalog/refresh`: the dashboard asks for the list again
//! when it opens and when the model menu opens, and gets the catalog as it
//! stands after the fetch.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use eos_contracts::{CatalogModel, CommandItem, UiBackendDescriptor, UiConfigResponseFeatures};
use eos_core::BoxFuture;
use eos_core::agent::{BackendCatalog, CommandCatalog, ModelCatalog};
use eos_core::os::ProcessStats;
use eos_mod_system::{LocalClock, Offers, RunInfo, SystemModule};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClock, FakeConfig, FakeTimeZone};
use serde_json::{Value, json};

/// A catalog whose fetch brings one model more than it had.
#[derive(Default)]
struct Catalog {
    fetches: AtomicUsize,
}

fn model(id: &str) -> CatalogModel {
    CatalogModel {
        id: id.into(),
        display_name: id.into(),
        created_at: "2026-05-01T00:00:00Z".into(),
        max_input_tokens: Some(1_000_000),
        max_tokens: None,
        effort_levels: None,
    }
}

impl ModelCatalog for Catalog {
    fn models(&self) -> Vec<CatalogModel> {
        (0..self.fetches.load(Ordering::SeqCst)).map(|n| model(&format!("claude-{n}"))).collect()
    }

    fn context_window_for(&self, _model: Option<&str>) -> i64 {
        1_000_000
    }

    fn refresh_now(&self) -> BoxFuture<'_, Vec<CatalogModel>> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::ready(self.models()))
    }
}

struct Nothing;

impl ProcessStats for Nothing {
    fn open_fds(&self) -> Option<u64> {
        None
    }

    fn fd_limit(&self) -> Option<u64> {
        None
    }
}

impl BackendCatalog for Nothing {
    fn descriptors(&self) -> Vec<UiBackendDescriptor> {
        Vec::new()
    }
}

impl CommandCatalog for Nothing {
    fn commands<'a>(&'a self, _cwd: Option<&'a Path>) -> BoxFuture<'a, Vec<CommandItem>> {
        Box::pin(std::future::ready(Vec::new()))
    }
}

async fn call(runtime: &Runtime, caller: Caller) -> (u16, Value) {
    let response = runtime.router.handle(Request::new(Method::Post, "/api/model-catalog/refresh", caller)).await;
    let status = response.status;
    let bytes = response.body.collect().await.expect("a body");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_refresh_answers_the_catalog_after_the_fetch_and_the_phone_may_not_ask() {
    let catalog = Arc::new(Catalog::default());
    let run = RunInfo { pid: 1, started_at: 0, source_stamp: "test".into() };
    let features = UiConfigResponseFeatures { remote: true, posix_shell: true };
    let offers = Offers { models: catalog.clone(), backends: Arc::new(Nothing), commands: Arc::new(Nothing) };
    let time = LocalClock { clock: Arc::new(FakeClock::new()), zone: Arc::new(FakeTimeZone::new("UTC", 0)) };
    let config = Arc::new(FakeConfig::default());
    let module = Arc::new(SystemModule::new(run, features, Arc::new(Nothing), config, offers, time));
    let runtime =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");

    let first = model("claude-0");
    assert_eq!(call(&runtime, Caller::DASHBOARD).await, (200, json!({"modelCatalog": [first]})));
    assert_eq!(call(&runtime, Caller::UNTRUSTED).await.0, 200, "any page of the window, as today");
    let phone = call(&runtime, Caller::Phone { grant: Tier::High, mutate: true }).await;
    assert_eq!(phone.0, 403, "{phone:?}");
    assert_eq!(catalog.fetches.load(Ordering::SeqCst), 2, "the phone's ask fetched nothing");
}
