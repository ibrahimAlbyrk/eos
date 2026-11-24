//! The module over the real store and a capability service with fakes for
//! everything outside, started and ready.

use std::sync::Arc;

use eos_capabilities::{CapabilityPorts, CapabilityService, Install};
use eos_core::capability::{AllInstalled, BuiltinCapability};
use eos_domain::capability::manifest::parse;
use eos_mod_capabilities::CapabilitiesModule;
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{
    FakeActionRunner, FakeCapabilityFiles, FakeCapabilitySecrets, FakeClock, FakeSleeper, FakeTrash, SeqIds, TempStore,
};
use serde_json::Value;

/// A planted secret: no answer may carry it.
pub(crate) const SECRET: &str = "gho_planted_secret_1";

/// A built-in of GitHub's shape: a token, a check, pull requests to pick,
/// and a review that speaks for the user.
pub(crate) const GITHUB: &str = r#"
id = "github"
name = "GitHub"
version = "1"
summary = "Pull requests and reviews on GitHub."
form = "builtin"
works = "any_mac"
health = { action = "check" }

[[secrets]]
name = "token"
label = "GitHub sign-in"

[[actions]]
name = "check"
summary = "See that the sign-in works."
class = "read"

[[actions]]
name = "list_pull_requests"
summary = "List open pull requests."
class = "read"

[[actions]]
name = "post_review"
summary = "Post a review."
class = "speak"
recipient = "input:/pull"
undo = "withdraw_review"
input = { type = "object", properties = { pull = { type = "string" } } }

[[actions]]
name = "withdraw_review"
summary = "Take a review back."
class = "speak"
recipient = "input:/pull"
input = { type = "object", properties = { pull = { type = "string" } } }

[[candidates]]
item = "github.pull_request"
action = "list_pull_requests"
"#;

/// A second built-in with nothing to set up.
pub(crate) const MAIL: &str = r#"
id = "mail"
name = "Mail"
version = "1"
summary = "Mail through the Mail app on this Mac."
form = "builtin"
works = "this_mac"

[[actions]]
name = "check"
summary = "See that Mail answers."
class = "read"
"#;

/// A package with a setting, installed in versions.
pub(crate) fn notes(version: &str) -> String {
    format!(
        r#"
id = "notes-db"
name = "Notes"
version = "{version}"
summary = "Reads your notes."
form = "script"
works = "this_mac"
reach = {{ hosts = ["notes.example.com"], apple_events = [], files_read = [] }}

[[settings]]
name = "folder"
label = "Notes folder"
kind = "choice"
choices = ["Work", "Home"]

[[actions]]
name = "list_notes"
summary = "List notes."
class = "read"
run = ["/bin/sh", "list.sh"]
"#
    )
}

pub(crate) struct Rig {
    pub(crate) runtime: Runtime,
    pub(crate) temp: TempStore,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) sleeper: Arc<FakeSleeper>,
    pub(crate) service: Arc<CapabilityService>,
    /// Where a sign-in's link back goes.
    pub(crate) links: eos_mod_capabilities::SignInLinks,
}

/// The module over these built-ins, with GitHub signed in when `signed_in`,
/// its app ready.
pub(crate) async fn rig(builtins: Vec<Arc<dyn BuiltinCapability>>, signed_in: bool) -> Rig {
    let secrets = if signed_in {
        FakeCapabilitySecrets::new().with("github", "token", SECRET)
    } else {
        FakeCapabilitySecrets::new()
    };
    rig_with(builtins, Arc::new(secrets)).await
}

/// The module over these built-ins and the secrets they share with the
/// service.
pub(crate) async fn rig_with(builtins: Vec<Arc<dyn BuiltinCapability>>, secrets: Arc<FakeCapabilitySecrets>) -> Rig {
    let temp = TempStore::new();
    let clock = Arc::new(FakeClock::new());
    let sleeper = Arc::new(FakeSleeper::default());
    let trash = Arc::new(FakeTrash::new(temp.home.join("trash")));
    let service = Arc::new(CapabilityService::new(
        CapabilityPorts {
            store: temp.port(),
            files: Arc::new(FakeCapabilityFiles::new(temp.home.join("capabilities"), trash)),
            secrets,
            grants: Arc::new(AllInstalled),
            runner: Some(Arc::new(FakeActionRunner::new())),
            clock: clock.clone(),
            ids: Arc::new(SeqIds::new()),
        },
        builtins,
    ));
    let module = Arc::new(CapabilitiesModule::new(service.clone(), temp.port(), clock.clone(), sleeper.clone()));
    let links = module.sign_in_links();
    let runtime =
        Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn)).expect("composes");
    assert_eq!(runtime.router.undeclared(), Vec::<String>::new());
    runtime.lifecycle.start().await.expect("starts");
    runtime.lifecycle.ready().await.expect("ready");
    Rig { runtime, temp, clock, sleeper, service, links }
}

impl Rig {
    pub(crate) async fn ask_as(&self, caller: Caller, method: Method, path: &str, body: Option<&str>) -> (u16, Value) {
        let mut request = Request::new(method, path, caller);
        if let Some(body) = body {
            request = request.body(body.to_owned());
        }
        let response = self.runtime.router.handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    pub(crate) async fn ask(&self, method: Method, path: &str, body: Option<&str>) -> (u16, Value) {
        self.ask_as(Caller::DASHBOARD, method, path, body).await
    }

    /// Installs `manifest` as a Forge package with `hash`.
    pub(crate) async fn install(&self, manifest: &str, hash: &str) {
        let parsed = parse(manifest).expect("a manifest");
        let folder = format!("forge/{}-{}", parsed.id, parsed.version);
        self.temp.home.write(format!("{folder}/capability.toml"), manifest);
        let install = Install {
            package_dir: self.temp.home.join(&folder),
            manifest: parsed,
            hash: hash.into(),
            origin: "forge".into(),
            source: "rn-0a1b2c3d4e5f".into(),
        };
        self.service.install(install).await.expect("installs");
    }

    /// `capabilities:change` payloads announced so far, as JSON text.
    pub(crate) fn changes(&self) -> Vec<String> {
        let announced = self.temp.announced.list();
        announced.into_iter().filter(|(topic, _)| *topic == "capabilities:change").map(|(_, payload)| payload).collect()
    }
}
