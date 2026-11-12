//! What `config.json` may hold (`DaemonConfigOverrideSchema`), and the
//! rewrites that keep files written by older versions valid.
//!
//! Every section and every field is optional. A file that breaks a rule is
//! ignored whole. Unknown top-level keys are fine (older versions wrote some);
//! unknown keys inside a section are dropped.

use eos_contracts::{
    AnthropicConfig, BackendProfile, GenuiConfig, Issues, McpServerDef, MemorySource, Num, RemoteConfigRateLimit,
    RemoteConfigRelay, Validate,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::{ArchiveRetention, CloseAction};

/// A struct whose fields are all optional and left out when absent. A `null`
/// reads as absent: the only fields that may be `null` default to it.
macro_rules! partial {
    ($(#[$meta:meta])* $name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $( #[serde(default, skip_serializing_if = "Option::is_none")] pub $field: Option<$ty>, )*
        }
    };
}

partial!(DaemonOverride { host: String, port: i64, raw_port: i64, home: String, sse_keepalive_ms: i64 });
partial!(PathsOverride { repo_root: String, claude_bin: String, bun_bin: String });
partial!(WorkerOverride {
    port_range_start: i64,
    port_range_end: i64,
    heartbeat_ms: i64,
    heartbeat_quiet_ms: i64,
    shutdown_grace_ms: i64,
    pty_write_delay_ms: i64,
    hydrate_env_files: bool,
});
partial!(EventsOverride { max_per_worker: i64 });
partial!(PermissionsOverride { default_ttl_ms: i64 });
partial!(AgentMcpOverride {
    inherit_defaults: bool,
    include: Vec<String>,
    exclude: Vec<String>,
    extra: IndexMap<String, McpServerDef>,
});
partial!(McpOverride { orchestrator: AgentMcpOverride, worker: AgentMcpOverride });
partial!(MemoryOverride { enabled: bool, sources: IndexMap<String, MemorySource> });
partial!(BackendChoiceOverride { backend: String });
partial!(RoleDefaultsOverride { orchestrator: BackendChoiceOverride, worker: BackendChoiceOverride });
partial!(JudgeOverride { model: String, temperature: f64 });
partial!(LoopOverride {
    enabled: bool,
    max_attempts: i64,
    strategy: String,
    no_progress_window: i64,
    stop_on_no_progress: bool,
    retry_on_failed: bool,
    judge: JudgeOverride,
});
partial!(ContextOverride { warn_ratio: f64, full_ratio: f64 });
partial!(CompactionOverride { enabled: bool, threshold: f64, timeout_ms: i64 });
partial!(CollaborateOverride { await_timeout_ms: i64 });
partial!(MicroTaskOverride { enabled: bool, delay_ms: i64, model: String, char_limit: i64, prompt_template: String });
partial!(MicroTasksOverride { enabled: bool, pause_max_ms: i64, tasks: IndexMap<String, MicroTaskOverride> });
partial!(ArchiveOverride { retention: ArchiveRetention, purge_on_app_close: bool, cmd_w: CloseAction });
partial!(UpdatesOverride { auto_download: bool, feed_url: String });
partial!(RemoteOverride {
    enabled: bool,
    relay: RemoteConfigRelay,
    inactivity_lease_ms: i64,
    rate_limit: RemoteConfigRateLimit,
});
partial!(PeerOverride {
    enabled: bool,
    direct: bool,
    port: i64,
    name: String,
    advertise: Vec<String>,
    relay_url: String,
});
partial!(BrowserOverride {
    enabled: bool,
    chrome_path: String,
    allowed_origins: Vec<String>,
    persist_profile: bool,
    per_session: bool,
});

/// The rates a flat price override changes; an unknown key is a mistake.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlatPriceOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#in: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_create: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_create_1h: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierPrice {
    pub r#in: f64,
    pub out: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_create: f64,
    #[serde(default)]
    pub cache_create_1h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceTierOverride {
    /// `None`: the open, last band.
    pub max_input_tokens: Option<i64>,
    pub price: TierPrice,
}

/// A whole tiered price, or the rates to change of a flat one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PriceOverride {
    Tiered { tiers: Vec<PriceTierOverride> },
    Flat(FlatPriceOverride),
}

partial!(
    /// `config.json`.
    ConfigOverride {
        daemon: DaemonOverride,
        paths: PathsOverride,
        worker: WorkerOverride,
        events: EventsOverride,
        permissions: PermissionsOverride,
        prices: IndexMap<String, PriceOverride>,
        mcp: McpOverride,
        memory: MemoryOverride,
        backends: IndexMap<String, BackendProfile>,
        defaults: RoleDefaultsOverride,
        r#loop: LoopOverride,
        context: ContextOverride,
        compaction: CompactionOverride,
        collaborate: CollaborateOverride,
        micro_tasks: MicroTasksOverride,
        archive: ArchiveOverride,
        updates: UpdatesOverride,
        remote: RemoteOverride,
        peer: PeerOverride,
        anthropic: AnthropicConfig,
        browser: BrowserOverride,
        genui: GenuiConfig,
    }
);

fn positive(cx: &mut Issues, key: &str, value: Option<i64>) {
    if let Some(v) = value {
        cx.at(key, |cx| cx.int_min(v, 0, false));
    }
}

fn non_negative(cx: &mut Issues, key: &str, value: Option<i64>) {
    if let Some(v) = value {
        cx.at(key, |cx| cx.int_min(v, 0, true));
    }
}

fn rate(cx: &mut Issues, key: &str, value: Option<f64>) {
    if let Some(v) = value {
        cx.at(key, |cx| cx.num_min(Num::from(v), 0.0, true));
    }
}

/// A share of something: above 0, at most 1.
fn ratio(cx: &mut Issues, key: &str, value: Option<f64>) {
    if let Some(v) = value {
        cx.at(key, |cx| {
            cx.num_min(Num::from(v), 0.0, false);
            cx.num_max(Num::from(v), 1.0, true);
        });
    }
}

fn nested<T: Validate>(cx: &mut Issues, key: &str, value: &Option<T>) {
    if let Some(v) = value {
        cx.at(key, |cx| v.validate(cx));
    }
}

fn each<T: Validate>(cx: &mut Issues, key: &str, record: &Option<IndexMap<String, T>>) {
    if let Some(record) = record {
        cx.at(key, |cx| {
            for (name, value) in record {
                cx.at(name, |cx| value.validate(cx));
            }
        });
    }
}

impl Validate for PriceOverride {
    fn validate(&self, cx: &mut Issues) {
        match self {
            PriceOverride::Flat(p) => {
                rate(cx, "in", p.r#in);
                rate(cx, "out", p.out);
                rate(cx, "cacheRead", p.cache_read);
                rate(cx, "cacheCreate", p.cache_create);
                rate(cx, "cacheCreate1h", p.cache_create_1h);
            }
            PriceOverride::Tiered { tiers } => cx.at("tiers", |cx| {
                cx.arr_min(tiers.len(), 1);
                for (i, tier) in tiers.iter().enumerate() {
                    cx.idx(i, |cx| {
                        non_negative(cx, "maxInputTokens", tier.max_input_tokens);
                        cx.at("price", |cx| {
                            let p = &tier.price;
                            rate(cx, "in", Some(p.r#in));
                            rate(cx, "out", Some(p.out));
                            rate(cx, "cacheRead", Some(p.cache_read));
                            rate(cx, "cacheCreate", Some(p.cache_create));
                            rate(cx, "cacheCreate1h", Some(p.cache_create_1h));
                        });
                    });
                }
            }),
        }
    }
}

impl Validate for AgentMcpOverride {}

impl Validate for ConfigOverride {
    fn validate(&self, cx: &mut Issues) {
        if let Some(s) = &self.daemon {
            cx.at("daemon", |cx| {
                positive(cx, "port", s.port);
                positive(cx, "rawPort", s.raw_port);
                positive(cx, "sseKeepaliveMs", s.sse_keepalive_ms);
            });
        }
        if let Some(s) = &self.worker {
            cx.at("worker", |cx| {
                positive(cx, "portRangeStart", s.port_range_start);
                positive(cx, "portRangeEnd", s.port_range_end);
                positive(cx, "heartbeatMs", s.heartbeat_ms);
                positive(cx, "heartbeatQuietMs", s.heartbeat_quiet_ms);
                positive(cx, "shutdownGraceMs", s.shutdown_grace_ms);
                non_negative(cx, "ptyWriteDelayMs", s.pty_write_delay_ms);
            });
        }
        if let Some(s) = &self.events {
            cx.at("events", |cx| non_negative(cx, "maxPerWorker", s.max_per_worker));
        }
        if let Some(s) = &self.permissions {
            cx.at("permissions", |cx| positive(cx, "defaultTtlMs", s.default_ttl_ms));
        }
        each(cx, "prices", &self.prices);
        each(cx, "backends", &self.backends);
        if let Some(s) = &self.memory {
            cx.at("memory", |cx| each(cx, "sources", &s.sources));
        }
        if let Some(s) = &self.r#loop {
            cx.at("loop", |cx| {
                non_negative(cx, "maxAttempts", s.max_attempts);
                positive(cx, "noProgressWindow", s.no_progress_window);
            });
        }
        if let Some(s) = &self.context {
            cx.at("context", |cx| {
                ratio(cx, "warnRatio", s.warn_ratio);
                ratio(cx, "fullRatio", s.full_ratio);
            });
        }
        if let Some(s) = &self.compaction {
            cx.at("compaction", |cx| {
                if let Some(v) = s.threshold {
                    cx.at("threshold", |cx| {
                        cx.num_min(Num::from(v), 0.1, true);
                        cx.num_max(Num::from(v), 0.99, true);
                    });
                }
                positive(cx, "timeoutMs", s.timeout_ms);
            });
        }
        if let Some(s) = &self.collaborate {
            cx.at("collaborate", |cx| positive(cx, "awaitTimeoutMs", s.await_timeout_ms));
        }
        if let Some(s) = &self.micro_tasks {
            cx.at("microTasks", |cx| {
                positive(cx, "pauseMaxMs", s.pause_max_ms);
                if let Some(tasks) = &s.tasks {
                    cx.at("tasks", |cx| {
                        for (id, task) in tasks {
                            cx.at(id, |cx| {
                                non_negative(cx, "delayMs", task.delay_ms);
                                positive(cx, "charLimit", task.char_limit);
                            });
                        }
                    });
                }
            });
        }
        if let Some(url) = self.updates.as_ref().and_then(|s| s.feed_url.as_deref()) {
            cx.at("updates", |cx| {
                cx.at("feedUrl", |cx| {
                    cx.url(url);
                    cx.starts_with(url, "https://");
                });
            });
        }
        if let Some(s) = &self.remote {
            cx.at("remote", |cx| {
                nested(cx, "relay", &s.relay);
                nested(cx, "rateLimit", &s.rate_limit);
            });
        }
        if let Some(port) = self.peer.as_ref().and_then(|s| s.port) {
            cx.at("peer", |cx| {
                cx.at("port", |cx| {
                    cx.int_min(port, 1, true);
                    cx.int_max(port, 65_535, true);
                });
            });
        }
        nested(cx, "genui", &self.genui);
    }
}

/// The file as accepted: only what the schema knows, ready to merge.
pub(super) fn check(raw: &Value) -> Result<Value, String> {
    let accepted: ConfigOverride = eos_contracts::parse(raw).map_err(|e| e.message())?;
    serde_json::to_value(accepted).map_err(|e| e.to_string())
}

/// Profile kinds and names of the lanes that merged into one Claude backend.
pub(super) fn renamed_kind(kind: &str) -> Option<&'static str> {
    matches!(kind, "claude-cli" | "claude-sdk").then_some("claude")
}

fn renamed_profile(name: &str) -> Option<&'static str> {
    Some(match name {
        "claude-sdk-opus" | "claude-cli-opus" => "claude-opus",
        "claude-sdk-sonnet" | "claude-cli-sonnet" => "claude-sonnet",
        "claude-sdk-haiku" | "claude-cli-haiku" => "claude-haiku",
        _ => return None,
    })
}

/// Rewrites what older versions wrote into today's keys, in place:
/// `remote.mode` / `remote.lan`, and the backend kinds and profile names from
/// before the two Claude lanes became one.
pub(super) fn migrate_legacy(raw: &mut Value) {
    let Value::Object(file) = raw else { return };

    if let Some(Value::Object(remote)) = file.get_mut("remote") {
        if let Some(mode) = remote.remove("mode")
            && !remote.contains_key("enabled")
        {
            remote.insert("enabled".into(), Value::Bool(mode == "lan" || mode == "relay"));
        }
        // Only the relay's address survives of the old relay block.
        if let Some(Value::Object(relay)) = remote.get("relay") {
            match relay.get("url").and_then(Value::as_str).map(str::to_owned) {
                Some(url) => remote.insert("relay".into(), serde_json::json!({ "url": url })),
                None => remote.remove("relay"),
            };
        }
        remote.remove("lan");
    }

    if let Some(Value::Object(backends)) = file.get_mut("backends") {
        let names: Vec<String> = backends.keys().cloned().collect();
        for name in names {
            if let Some(Value::Object(profile)) = backends.get_mut(&name)
                && let Some(kind) = profile.get("kind").and_then(Value::as_str).and_then(renamed_kind)
            {
                profile.insert("kind".into(), kind.into());
            }
            if let Some(new_name) = renamed_profile(&name)
                && let Some(profile) = backends.shift_remove(&name)
            {
                // A profile the user already wrote under the new name wins.
                if !backends.get(new_name).is_some_and(|existing| !existing.is_null()) {
                    backends.insert(new_name.to_owned(), profile);
                }
            }
        }
    }

    if let Some(Value::Object(defaults)) = file.get_mut("defaults") {
        for role in ["orchestrator", "worker"] {
            if let Some(Value::Object(choice)) = defaults.get_mut(role)
                && let Some(new_name) = choice.get("backend").and_then(Value::as_str).and_then(renamed_profile)
            {
                choice.insert("backend".into(), new_name.into());
            }
        }
    }
}
