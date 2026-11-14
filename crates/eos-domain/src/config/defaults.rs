//! The built-in configuration, with the environment's overrides applied.

use std::collections::BTreeMap;

use serde_json::{Value, json};

/// The `EOS_*` environment variables, captured once by whoever starts the
/// app: nothing below reads the process environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Env(BTreeMap<String, String>);

impl Env {
    pub fn new(vars: impl IntoIterator<Item = (String, String)>) -> Self {
        Self(vars.into_iter().collect())
    }

    fn text(&self, name: &str, fallback: &str) -> String {
        self.0.get(name).cloned().unwrap_or_else(|| fallback.to_owned())
    }

    /// A finite number, as JavaScript's `Number(v)` reads the common forms;
    /// anything else keeps the fallback.
    fn int(&self, name: &str, fallback: i64) -> i64 {
        let Some(raw) = self.0.get(name) else { return fallback };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            // Number("") is 0.
            return 0;
        }
        match trimmed.parse::<f64>() {
            Ok(n) if n.is_finite() && n.fract() == 0.0 => n as i64,
            _ => fallback,
        }
    }

    /// `1` is on, `0` is off, anything else keeps the fallback.
    fn flag(&self, name: &str, fallback: bool) -> bool {
        match self.0.get(name).map(String::as_str) {
            Some("1") => true,
            Some("0") => false,
            _ => fallback,
        }
    }
}

/// What the defaults depend on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Host {
    /// The data folder.
    pub home: String,
    pub env: Env,
    /// The system can pair with other devices (decides whether remote access
    /// and hosting default to on).
    pub remote_feature: bool,
}

const DEFAULT_RELAY_URL: &str = "wss://silver-giraffe-71764.zap.cloud/";

fn flat(input: f64, output: f64, cache_read: f64, cache_create: f64, cache_create_1h: f64) -> Value {
    json!({ "in": input, "out": output, "cacheRead": cache_read, "cacheCreate": cache_create, "cacheCreate1h": cache_create_1h })
}

/// One band of a price that steps up with the prompt size.
fn tier(max_input_tokens: Option<i64>, input: f64, output: f64) -> Value {
    json!({ "maxInputTokens": max_input_tokens, "price": flat(input, output, 0.0, 0.0, 0.0) })
}

/// Per-million-token prices. Family names match by substring (see
/// [`price_for_model`](super::price_for_model)).
fn prices() -> Value {
    json!({
        "fable": flat(10.0, 50.0, 1.0, 12.5, 20.0),
        "opus": flat(15.0, 75.0, 1.5, 18.75, 30.0),
        "sonnet": flat(3.0, 15.0, 0.3, 3.75, 6.0),
        "haiku": flat(1.0, 5.0, 0.1, 1.25, 2.0),
        "glm-5.2": flat(1.4, 4.4, 0.0, 0.0, 0.0),
        "glm-4.7": flat(0.6, 2.2, 0.0, 0.0, 0.0),
        "qwen3.7-max": { "tiers": [tier(None, 2.5, 7.5)] },
        "qwen3.7-plus": { "tiers": [tier(Some(128_000), 0.4, 1.6), tier(Some(256_000), 0.8, 3.2), tier(None, 1.2, 4.8)] },
        "qwen3-coder-plus": { "tiers": [tier(Some(256_000), 0.3, 1.5), tier(None, 6.0, 60.0)] },
    })
}

fn agent_mcp() -> Value {
    json!({ "inheritDefaults": true, "include": ["*"], "exclude": [], "extra": {} })
}

pub(super) fn defaults(host: &Host) -> Value {
    let env = &host.env;
    let home = host.home.trim_end_matches('/');
    let mut out = serde_json::Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.to_owned(), value);
    };
    put(
        "daemon",
        json!({
            "home": home,
            "logDir": format!("{home}/logs"),
            "dbFile": format!("{home}/state.db"),
            "sseKeepaliveMs": env.int("EOS_SSE_KEEPALIVE_MS", 25_000),
        }),
    );
    put("paths", json!({ "claudeBin": env.text("EOS_CLAUDE_BIN", "claude") }));
    put(
        "worker",
        json!({
            "portRangeStart": env.int("EOS_WORKER_PORT_START", 7500),
            "portRangeEnd": env.int("EOS_WORKER_PORT_END", 7699),
            "heartbeatMs": env.int("EOS_HEARTBEAT_MS", 8000),
            "heartbeatQuietMs": env.int("EOS_HEARTBEAT_QUIET_MS", 6000),
            "shutdownGraceMs": env.int("EOS_SHUTDOWN_GRACE_MS", 2500),
            "ptyWriteDelayMs": env.int("EOS_PTY_WRITE_DELAY_MS", 300),
            "hydrateEnvFiles": env.text("EOS_HYDRATE_ENV_FILES", "") == "1",
        }),
    );
    put("events", json!({ "maxPerWorker": env.int("EOS_EVENTS_MAX_PER_WORKER", 20_000) }));
    put("permissions", json!({ "defaultTtlMs": env.int("EOS_PERMISSION_TTL_MS", 0) }));
    put("prices", prices());
    put("mcp", json!({ "orchestrator": agent_mcp(), "worker": agent_mcp() }));
    put(
        "memory",
        json!({
            "enabled": true,
            "sources": {
                "claude": {
                    "enabled": true,
                    "label": "CLAUDE.md",
                    "userPaths": ["~/.claude/CLAUDE.md"],
                    "projectFilenames": ["CLAUDE.md"],
                    "priority": 0,
                    "assumeNativeFor": ["claude"],
                },
            },
        }),
    );
    put(
        "backends",
        json!({
            "claude-opus": {
                "kind": "claude",
                "model": "claude-opus-5-5",
                "auth": { "kind": "subscription" },
                "costMode": "included",
                "params": { "thinking": { "type": "adaptive", "display": "summarized" } },
            },
        }),
    );
    put("defaults", json!({ "orchestrator": { "backend": "claude-opus" }, "worker": { "backend": "claude-opus" } }));
    put("context", json!({ "warnRatio": 0.9, "fullRatio": 0.95 }));
    put("compaction", json!({ "enabled": true, "threshold": 0.7, "timeoutMs": 300_000 }));
    put("collaborate", json!({ "awaitTimeoutMs": env.int("EOS_COLLABORATE_AWAIT_TIMEOUT_MS", 120_000) }));
    put(
        "microTasks",
        json!({
            "enabled": true,
            "pauseMaxMs": 10_000,
            "tasks": { "auto-name": { "enabled": true, "delayMs": 5000, "model": "claude-sonnet-5-5", "charLimit": 280 } },
        }),
    );
    put("archive", json!({ "retention": "weekly", "purgeOnAppClose": false, "cmdW": "archive" }));
    put("updates", json!({ "autoDownload": true, "feedUrl": null }));
    put(
        "remote",
        json!({
            "enabled": env.flag("EOS_REMOTE_ENABLED", host.remote_feature),
            "relay": { "url": env.text("EOS_REMOTE_RELAY_URL", DEFAULT_RELAY_URL) },
            "inactivityLeaseMs": env.int("EOS_REMOTE_LEASE_MS", 30 * 60 * 1000),
            "rateLimit": { "perDevicePerMin": 120, "globalPerMin": 600, "pairingPerMin": 5 },
        }),
    );
    put(
        "peer",
        json!({
            "enabled": env.flag("EOS_PEER_ENABLED", host.remote_feature),
            "direct": true,
            "port": env.int("EOS_PEER_PORT", 7402),
        }),
    );
    put("anthropic", json!({}));
    put(
        "browser",
        json!({ "enabled": true, "chromePath": null, "allowedOrigins": [], "persistProfile": true, "perSession": true }),
    );
    put("genui", json!({}));
    Value::Object(out)
}
