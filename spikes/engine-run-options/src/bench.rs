//! A throwaway data folder laid out as Eos lays out `~/.eos`, an engine built
//! the way `eos-engine` builds it, and a session started the way it starts a
//! focused chat (`crates/eos-engine/src/engine.rs`, `Engine::build` and
//! `Engine::options`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use eos_agent_compat::ClaudePaths;
use eos_agent_core::{Credential, PermissionGate, StaticCredential};
use eos_agent_mock_api::{MockApi, Reply};
use eos_agent_sdk::{AgentOptions, Sdk, SdkAgent};
use serde_json::Value;

use crate::gate::RecordingGate;

pub const MODEL: &str = "mock-model";

/// One case's folders, all in a temporary directory:
/// `home/` (Claude Code's home), `project/` (the session's folder), `extra/`
/// (a further root), `eos/` (Eos's data folder) with `eos/engine/` (the
/// engine's own folder).
pub struct Dirs {
    _tmp: tempfile::TempDir,
    pub root: PathBuf,
}

impl Dirs {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().expect("a temporary folder");
        // The engine canonicalizes the session's folder (`/var` is `/private/var`).
        let root = std::fs::canonicalize(tmp.path()).expect("canonical");
        for dir in ["home", "project", "extra", "eos/engine"] {
            std::fs::create_dir_all(root.join(dir)).expect("a folder");
        }
        Self { _tmp: tmp, root }
    }

    pub fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    pub fn project(&self) -> PathBuf {
        self.root.join("project")
    }

    pub fn extra(&self) -> PathBuf {
        self.root.join("extra")
    }

    /// Eos's data folder, `~/.eos` in the app.
    pub fn eos(&self) -> PathBuf {
        self.root.join("eos")
    }

    /// `~/.eos/engine`, as `EngineOptions::dir`.
    pub fn engine(&self) -> PathBuf {
        self.eos().join("engine")
    }

    /// `~/.eos/routines`, where a kept version's script is written
    /// (`routines/<rid>/scripts/<versionId>.js`, 01 G9).
    pub fn routines(&self) -> PathBuf {
        self.eos().join("routines")
    }

    /// The agent's scratch folder: `<engine>/data/scratch/<agent id>`.
    pub fn scratch(&self, agent_id: &str) -> PathBuf {
        self.engine().join("data/scratch").join(agent_id)
    }

    /// Writes `text` at `rel` under the root and returns the full path.
    pub fn write(&self, rel: &str, text: &str) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a folder");
        std::fs::write(&path, text).expect("written");
        path
    }
}

impl Default for Dirs {
    fn default() -> Self {
        Self::new()
    }
}

/// Every request body the mock received, in order.
pub type Seen = Arc<Mutex<Vec<Value>>>;

pub struct Bench {
    pub sdk: Sdk,
    pub gate: Arc<RecordingGate>,
    seen: Seen,
    _mock: MockApi,
}

impl Bench {
    /// The mock answers each request with `respond(body)`; every body is kept.
    pub async fn start(
        dirs: &Dirs,
        gate: RecordingGate,
        respond: impl Fn(&Value) -> Reply + Send + Sync + 'static,
    ) -> Self {
        let seen: Seen = Arc::default();
        let log = Arc::clone(&seen);
        let mock = MockApi::responder(SocketAddr::from(([127, 0, 0, 1], 0)), move |raw| {
            let body: Value = serde_json::from_slice(raw).unwrap_or_default();
            log.lock().unwrap_or_else(PoisonError::into_inner).push(body.clone());
            respond(&body)
        })
        .await
        .expect("the mock API");
        let gate = Arc::new(gate);
        let engine = dirs.engine();
        // As `Engine::build`: data and workflow folders inside the engine's
        // folder, which no tool writes. A fake key: only the mock hears it.
        let sdk = Sdk::builder()
            .auth(Arc::new(StaticCredential(Credential::ApiKey("k".into()))))
            .base_url(mock.base_url())
            .model(MODEL)
            .claude_paths(ClaudePaths::for_home(&dirs.home()))
            .permissions(Arc::clone(&gate) as Arc<dyn PermissionGate>)
            .data_dir(engine.join("data"))
            .workflow_dir(engine.join("workflows"))
            .protect_from_writes(engine)
            // `routines/` joins Eos's agent-protected entries with the routines module.
            .protect_from_writes(dirs.routines())
            .build()
            .await
            .expect("the engine");
        Self { sdk, gate, seen, _mock: mock }
    }

    pub fn requests(&self) -> Vec<Value> {
        self.seen.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Starts `options`, sends `prompt` as typed (Eos sends with
    /// `send_input`), and waits for the turn, its subagents, its background
    /// runs and the turns their reports wake.
    pub async fn run(&self, options: AgentOptions, prompt: &str) -> SdkAgent {
        let (agent, _events) = self.sdk.spawn(options).await.expect("spawned");
        agent.send_input(prompt).await.expect("accepted").expect("a turn");
        tokio::time::timeout(Duration::from_secs(30), agent.settle()).await.expect("settled in time");
        agent
    }
}

/// The options `Engine::options` builds for a focused session: the worker id
/// as the agent's id, the further folders as roots, the configured MCP
/// servers on (`EngineOptions::mcp`, on in the app), tool search on, the
/// `CLAUDE.md` files on (Eos never sets `claude_md`), no tool taken away.
pub fn focused(dirs: &Dirs, id: &str) -> AgentOptions {
    AgentOptions::new(dirs.project()).id(id).model(MODEL).roots(vec![dirs.extra()]).mcp(true).tool_search(true)
}

/// Whether `path` appears within a few seconds (a process the engine starts
/// in the background).
pub async fn appears(path: &Path) -> bool {
    for _ in 0..40 {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}
