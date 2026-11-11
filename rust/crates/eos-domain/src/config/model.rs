//! The shape of the resolved configuration.

use eos_contracts::{
    AnthropicConfig, BackendProfile, GenuiConfig, McpServerDef, MemorySource, ModelPricing, PeerConfig, RemoteConfig,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub daemon: Home,
    pub paths: Paths,
    pub worker: WorkerTuning,
    pub events: Events,
    pub permissions: Permissions,
    /// Per-million-token prices by model name, in the order they were declared.
    pub prices: IndexMap<String, ModelPricing>,
    pub mcp: Mcp,
    pub memory: Memory,
    /// Named backend profiles: the built-in ones plus the user's.
    pub backends: IndexMap<String, BackendProfile>,
    pub defaults: RoleDefaults,
    pub r#loop: Loop,
    pub context: ContextRatios,
    pub compaction: Compaction,
    pub collaborate: Collaborate,
    pub micro_tasks: MicroTasks,
    pub archive: Archive,
    pub updates: Updates,
    pub remote: RemoteConfig,
    pub peer: PeerConfig,
    pub anthropic: AnthropicConfig,
    pub browser: Browser,
    pub genui: GenuiConfig,
}

/// The `daemon` key of the file: where the data lives and how the stream breathes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    /// The data folder.
    pub home: String,
    pub log_dir: String,
    pub db_file: String,
    /// How often an idle event stream gets a keep-alive comment.
    pub sse_keepalive_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    /// The user's `claude` program (a path, or a name to find on `PATH`).
    pub claude_bin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTuning {
    pub port_range_start: i64,
    pub port_range_end: i64,
    pub heartbeat_ms: i64,
    pub heartbeat_quiet_ms: i64,
    pub shutdown_grace_ms: i64,
    pub pty_write_delay_ms: i64,
    /// Copy `.env` files into a new worktree.
    pub hydrate_env_files: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Events {
    /// Each worker keeps its newest this-many events; 0 keeps them all.
    pub max_per_worker: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub default_ttl_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcp {
    pub inherit_defaults: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub extra: IndexMap<String, McpServerDef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mcp {
    pub orchestrator: AgentMcp,
    pub worker: AgentMcp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Memory {
    pub enabled: bool,
    pub sources: IndexMap<String, MemorySource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendChoice {
    /// The name of a backend profile.
    pub backend: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleDefaults {
    pub orchestrator: BackendChoice,
    pub worker: BackendChoice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Judge {
    pub model: String,
    pub temperature: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loop {
    pub enabled: bool,
    /// `None`: no cap.
    pub max_attempts: Option<i64>,
    pub strategy: String,
    pub no_progress_window: i64,
    pub stop_on_no_progress: bool,
    pub retry_on_failed: bool,
    pub judge: Judge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRatios {
    pub warn_ratio: f64,
    pub full_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    pub enabled: bool,
    /// The share of the context window at which a session is compacted.
    pub threshold: f64,
    pub timeout_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collaborate {
    pub await_timeout_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicroTask {
    pub enabled: bool,
    pub delay_ms: i64,
    pub model: String,
    pub char_limit: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_template: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicroTasks {
    pub enabled: bool,
    pub pause_max_ms: i64,
    pub tasks: IndexMap<String, MicroTask>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveRetention {
    Off,
    Daily,
    Weekly,
    Monthly,
}

/// What closing a chat's tab does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    Archive,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    pub retention: ArchiveRetention,
    pub purge_on_app_close: bool,
    pub cmd_w: CloseAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Updates {
    pub auto_download: bool,
    /// `None`: the built-in feed.
    pub feed_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    pub enabled: bool,
    pub chrome_path: Option<String>,
    pub allowed_origins: Vec<String>,
    pub persist_profile: bool,
    pub per_session: bool,
}
