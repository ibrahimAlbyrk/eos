//! The service on the real store, with fakes for everything outside.

use std::path::PathBuf;
use std::sync::Arc;

use eos_capabilities::{CapabilityPorts, CapabilityService, Install};
use eos_core::capability::{
    ActionCall, ActionCaller, AllInstalled, BuiltinCapability, CapabilityGrants, CapabilitySecrets,
};
use eos_domain::capability::manifest::parse;
use eos_testkit::{
    FakeActionRunner, FakeBuiltin, FakeCapabilityFiles, FakeCapabilitySecrets, FakeClock, FakeTrash, SeqIds, TempStore,
};
use serde_json::Value;

pub(crate) const SECRET: &str = "gho_planted_secret_1";

/// A built-in of GitHub's shape: a token, a check, a read with an
/// untrusted title, a speaking action.
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
name = "get_pull_request"
summary = "Read a pull request."
class = "read"
input = { type = "object", required = ["number"], properties = { number = { type = "integer" } } }
output = { type = "object", properties = { number = { type = "integer" }, title = { type = "string", untrusted = true } } }

[[actions]]
name = "post_review"
summary = "Post a review."
class = "speak"
recipient = "input:/pull"
input = { type = "object", properties = { pull = { type = "string" } } }
"#;

/// A script package with a secret handed to its code.
pub(crate) fn notes(version: &str) -> String {
    format!(
        r#"
id = "notes-db"
name = "Notes"
version = "{version}"
summary = "Reads your notes."
form = "script"
works = "this_mac"
instructions = "README.md"
health = {{ action = "check" }}

[[secrets]]
name = "api_key"
label = "Notes API key"
env = "NOTES_KEY"

[[settings]]
name = "folder"
label = "Your notes folder"
kind = "text"

[[actions]]
name = "check"
summary = "See that it works."
class = "read"
run = ["/bin/sh", "check.sh"]

[[actions]]
name = "list_notes"
summary = "List notes."
class = "read"
run = ["/bin/sh", "list.sh"]
input = {{ type = "object", properties = {{ q = {{ type = "string" }} }} }}
"#
    )
}

pub(crate) struct Rig {
    pub(crate) temp: TempStore,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) secrets: Arc<FakeCapabilitySecrets>,
    pub(crate) runner: Arc<FakeActionRunner>,
    pub(crate) files: Arc<FakeCapabilityFiles>,
    pub(crate) trash: Arc<FakeTrash>,
    pub(crate) service: Arc<CapabilityService>,
}

pub(crate) struct Setup {
    pub(crate) builtins: Vec<Arc<dyn BuiltinCapability>>,
    pub(crate) secrets: FakeCapabilitySecrets,
    pub(crate) runner: FakeActionRunner,
    pub(crate) grants: Arc<dyn CapabilityGrants>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            builtins: Vec::new(),
            secrets: FakeCapabilitySecrets::new(),
            runner: FakeActionRunner::new(),
            grants: Arc::new(AllInstalled),
        }
    }
}

/// The service, started.
pub(crate) async fn rig(setup: Setup) -> Rig {
    let temp = TempStore::new();
    let clock = Arc::new(FakeClock::at(1_000));
    let trash = Arc::new(FakeTrash::new(temp.home.join("trash")));
    let files = Arc::new(FakeCapabilityFiles::new(temp.home.join("capabilities"), trash.clone()));
    let secrets = Arc::new(setup.secrets);
    let runner = Arc::new(setup.runner);
    let ports = CapabilityPorts {
        store: temp.port(),
        files: files.clone(),
        secrets: secrets.clone(),
        grants: setup.grants,
        runner: Some(runner.clone()),
        clock: clock.clone(),
        ids: Arc::new(SeqIds::new()),
    };
    let service = Arc::new(CapabilityService::new(ports, setup.builtins));
    service.start().await.expect("starts");
    Rig { temp, clock, secrets, runner, files, trash, service }
}

/// A GitHub built-in signed in with [`SECRET`].
pub(crate) async fn github_rig(github: Arc<FakeBuiltin>) -> Rig {
    rig(Setup {
        builtins: vec![github],
        secrets: FakeCapabilitySecrets::new().with("github", "token", SECRET),
        ..Setup::default()
    })
    .await
}

pub(crate) fn agent_call(capability: &str, action: &str, input: Value) -> ActionCall {
    ActionCall {
        capability: capability.into(),
        action: action.into(),
        input,
        caller: ActionCaller::Agent { worker_id: "w-1".into() },
        idempotency_key: None,
    }
}

impl Rig {
    /// A package folder holding `manifest` and a README.
    pub(crate) fn package(&self, name: &str, manifest: &str) -> PathBuf {
        self.temp.home.write(format!("forge/{name}/capability.toml"), manifest);
        self.temp.home.write(format!("forge/{name}/README.md"), format!("How to use {name}."));
        self.temp.home.join(format!("forge/{name}"))
    }

    /// Installs `manifest` from a package folder of its own, with its key set.
    pub(crate) async fn install(&self, manifest: &str, hash: &str) {
        let parsed = parse(manifest).expect("a manifest");
        let dir = self.package(&format!("{}-{}", parsed.id, parsed.version), manifest);
        self.secrets.write(&parsed.id, "api_key", "nk_planted_key_2".to_owned().into()).await.expect("the key");
        let install = Install {
            package_dir: dir,
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
