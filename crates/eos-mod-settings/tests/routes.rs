//! The settings routes over a real `config.json` and settings store, against
//! what today's daemon answered (`33-settings`).

use std::sync::Arc;

use eos_config::ConfigFile;
use eos_domain::config::Env;
use eos_mod_settings::SettingsModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::module::ProtectedSettings;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::fixtures::recorded_response;
use eos_testkit::{FakeSettings, TempHome};
use serde_json::{Value, json};

struct Bench {
    runtime: Runtime,
    _home: TempHome,
}

impl Bench {
    fn new() -> Self {
        let home = TempHome::new();
        // The recordings' data folder keeps archived chats (`seed/home/config.json`).
        std::fs::write(home.path().join("config.json"), r#"{"archive":{"retention":"off"}}"#).expect("written");
        let config = Arc::new(ConfigFile::load(home.path(), Env::new([]), true));
        let genui = ProtectedSettings { keys: vec!["genui.level", "location.share"], via: "/api/settings/genui" };
        let module = SettingsModule::new(Arc::new(FakeSettings::default()), config, vec![genui]);
        let runtime =
            Runtime::build(Kernel::new(KernelOptions::default()), vec![Arc::new(module)], Arc::new(AllPluginsOn))
                .expect("composes");
        Self { runtime, _home: home }
    }

    async fn call(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::new(method, target, Caller::DASHBOARD);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let res = self.runtime.router.handle(request).await;
        let status = res.status;
        let bytes = res.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

fn recorded(step: &str) -> (u16, Value) {
    let res = recorded_response("33-settings", step);
    let status = u16::try_from(res["status"].as_u64().expect("a status")).expect("fits");
    (status, res["json"].clone())
}

#[tokio::test]
async fn the_flat_settings_are_read_and_written_and_a_protected_key_is_refused() {
    let bench = Bench::new();
    assert_eq!(bench.call(Method::Get, "/api/settings", None).await, recorded("settings"));
    let saved = json!({"settings": {"appearance.theme": "dark", "model.default": "opus", "verbose.enabled": true}});
    assert_eq!(bench.call(Method::Put, "/api/settings", Some(saved)).await, recorded("settings-save"));
    let protected = json!({"settings": {"genui.level": "rich"}});
    assert_eq!(bench.call(Method::Put, "/api/settings", Some(protected)).await, recorded("settings-protected-key"));
    let bad = json!({"settings": "dark"});
    assert_eq!(bench.call(Method::Put, "/api/settings", Some(bad)).await, recorded("settings-bad-shape"));
}

#[tokio::test]
async fn the_archive_and_compaction_sections_are_merged_into_the_configuration() {
    let bench = Bench::new();
    assert_eq!(bench.call(Method::Get, "/api/settings/archive", None).await, recorded("archive"));
    let close = json!({"cmdW": "delete"});
    assert_eq!(bench.call(Method::Put, "/api/settings/archive", Some(close)).await, recorded("archive-save"));
    let bad = json!({"retention": "sometimes"});
    assert_eq!(bench.call(Method::Put, "/api/settings/archive", Some(bad)).await, recorded("archive-bad-value"));

    assert_eq!(bench.call(Method::Get, "/api/settings/compaction", None).await, recorded("compaction"));
    let threshold = json!({"threshold": 0.8});
    assert_eq!(bench.call(Method::Put, "/api/settings/compaction", Some(threshold)).await, recorded("compaction-save"));
    let unknown = json!({"thresholds": 0.8});
    assert_eq!(
        bench.call(Method::Put, "/api/settings/compaction", Some(unknown)).await,
        recorded("compaction-unknown-key")
    );
    let low =
        bench.call(Method::Put, "/api/settings/compaction", Some(json!({"threshold": 0.05, "timeoutMs": 0}))).await;
    assert_eq!(
        low,
        (
            400,
            json!({"error": "invalid request: threshold: Number must be greater than or equal to 0.1; timeoutMs: Number must be greater than 0"})
        )
    );
}
