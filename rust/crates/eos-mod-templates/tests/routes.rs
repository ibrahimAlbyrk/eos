//! The template routes over a real templates folder, answer by answer as
//! the Node daemon recorded them (`33-settings`). The whole scenario is
//! replayed against the composed app by `scripts/replay.sh`.

use std::sync::Arc;

use eos_core::SystemClock;
use eos_mod_templates::TemplatesModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_store_files::templates::FsTemplateStore;
use eos_testkit::{TempHome, fixtures};
use serde_json::Value;

#[tokio::test(flavor = "multi_thread")]
async fn templates_are_created_changed_listed_and_trashed_as_recorded() {
    let home = TempHome::new();
    let templates = Arc::new(FsTemplateStore::new(home.join("templates"), Arc::new(SystemClock)));
    let module = Arc::new(TemplatesModule::new(templates));
    let app =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");

    // Each recorded step, sent as recorded; the answer must be the recorded one.
    let recording = fixtures::recording("33-settings");
    for step in [
        "templates",
        "template-create",
        "template-update",
        "template-update-unknown",
        "templates-after",
        "template-delete",
        "template-delete-unknown",
    ] {
        let exchange = recording["exchanges"]
            .as_array()
            .and_then(|all| all.iter().find(|e| e["step"]["name"] == step))
            .unwrap_or_else(|| panic!("no step {step}"));
        let (method, path) = exchange["step"]["request"].as_str().and_then(|r| r.split_once(' ')).expect("a request");
        let mut request = Request::new(Method::parse(method).expect("a method"), path, Caller::DASHBOARD);
        if let Some(body) = exchange["step"].get("body") {
            request = request.body(body.to_string());
        }
        let res = app.router.handle(request).await;
        assert_eq!(Value::from(res.status), exchange["response"]["status"], "{step}");
        let body: Value = serde_json::from_slice(&res.body.collect().await.expect("a body")).expect("json");
        assert_eq!(body, exchange["response"]["json"], "{step}");
    }

    // A second create of a name that exists is refused; the deleted one is in the trash.
    let create = |name: &str| {
        let body = format!(r#"{{"name":"{name}","content":"x"}}"#);
        app.router.handle(Request::new(Method::Post, "/api/templates", Caller::DASHBOARD).body(body))
    };
    assert_eq!(create("twice").await.status, 200);
    let again = create("twice").await;
    assert_eq!(again.status, 409);
    assert_eq!(&again.body.collect().await.expect("a body")[..], br#"{"error":"template \"twice\" already exists"}"#);
    assert_eq!(std::fs::read_dir(home.join("templates/.trash")).expect("the trash").count(), 1);
}
