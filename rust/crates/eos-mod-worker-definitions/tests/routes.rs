//! Whose definitions an orchestrator sees, and what its removal does. The
//! recorded steps of these routes are replayed against the composed app
//! (`scripts/replay.sh`).

use std::sync::Arc;

use eos_core::SystemClock;
use eos_core::store::{Announcement, Announcer};
use eos_kit_sqlite::Db;
use eos_mod_worker_definitions::WorkerDefinitionsModule;
use eos_runtime::access::Caller;
use eos_runtime::bus::Bus;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_files::worker_definitions::FsWorkerDefinitionFiles;
use eos_store_sqlite::{SqliteStore, StoreOptions};
use eos_testkit::{TempHome, fixtures};
use eos_workers::WorkerDefinitions;
use serde_json::Value;

/// Hands committed writes' events to the bus, as the app does.
struct BusAnnouncer(Bus);

impl Announcer for BusAnnouncer {
    fn announce(&self, events: Vec<Announcement>) {
        for event in events {
            self.0.publish_raw(event.topic, None, event.payload.into());
        }
    }
}

fn app(home: &TempHome, sandbox: &str) -> Runtime {
    let kernel = Kernel::new(KernelOptions::default());
    let (db, _) = Db::open(home.paths().state_db(), eos_kit_sqlite::Options::default(), 0).expect("a database");
    let store = Arc::new(SqliteStore::new(db, Arc::new(BusAnnouncer(kernel.bus.clone())), StoreOptions::default()));
    let seed = fixtures::seed_sql(sandbox);
    store
        .db()
        .maintain(move |conn| conn.execute_batch(&seed).map_err(eos_kit_sqlite::Error::from))
        .expect("the seed rows");
    let files = Arc::new(FsWorkerDefinitionFiles::new(home.join("workers")));
    let definitions = Arc::new(WorkerDefinitions::new(files, store, Arc::new(SystemClock)));
    let module = Arc::new(WorkerDefinitionsModule::new(definitions));
    Runtime::build(kernel, vec![module], Arc::new(AllPluginsOn)).expect("composes")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_owners_definitions_go_with_its_worker_row() {
    let home = TempHome::new();
    home.write("workers/reviewer.md", "---\nname: reviewer\ndescription: The user's\n---\nReview.\n");
    let app = app(&home, "/sandbox");
    app.lifecycle.start().await.expect("starts");
    let names = |owner: &'static str| {
        let router = app.router.clone();
        async move {
            let target = format!("/worker-definitions?owner={owner}");
            let res = router.handle(Request::new(Method::Get, &target, Caller::DASHBOARD)).await;
            let rows: Value = serde_json::from_slice(&res.body.collect().await.expect("a body")).expect("json");
            let pairs: Vec<String> = rows
                .as_array()
                .expect("rows")
                .iter()
                .map(|r| {
                    format!("{}:{}", r["name"].as_str().unwrap_or_default(), r["source"].as_str().unwrap_or_default())
                })
                .collect();
            pairs.join(" ")
        }
    };
    let create = |body: &'static str| {
        let router = app.router.clone();
        async move {
            let req = Request::new(Method::Post, "/worker-definitions?owner=o-ORCH", Caller::DASHBOARD).body(body);
            router.handle(req).await.status
        }
    };
    assert_eq!(create(r#"{"name":"reviewer","description":"mine","body":"Runtime review."}"#).await, 201);
    assert_eq!(create(r#"{"name":"doc-writer"}"#).await, 201);
    assert_eq!(create(r#"{"name":"doc-writer","description":"again"}"#).await, 201, "a second save replaces");

    let own =
        "explorer:builtin general-purpose:builtin git:builtin researcher:builtin reviewer:runtime doc-writer:runtime";
    assert_eq!(names("o-ORCH").await, own, "its own definition replaces the user's in place");
    let others = "explorer:builtin general-purpose:builtin git:builtin researcher:builtin reviewer:user";
    assert_eq!(names("w-LONG").await, others, "another session never sees them");
}
