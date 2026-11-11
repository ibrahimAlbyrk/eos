use serde_json::{Value, json};

use super::*;

fn host(env: &[(&str, &str)]) -> Host {
    Host {
        home: "/Users/me/.eos".into(),
        env: Env::new(env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))),
        remote_feature: true,
    }
}

fn with_file(file: Value) -> (Config, Option<Rejected>) {
    resolve(&host(&[]), Some(file))
}

#[test]
fn the_defaults_are_todays() {
    let (config, rejected) = resolve(&host(&[]), None);
    assert_eq!(rejected, None);
    assert_eq!(config.daemon.db_file, "/Users/me/.eos/state.db");
    assert_eq!(config.daemon.sse_keepalive_ms, 25_000);
    assert_eq!(config.events.max_per_worker, 20_000);
    assert_eq!(config.permissions.default_ttl_ms, 0);
    assert_eq!(config.defaults.orchestrator.backend, "claude-opus");
    assert_eq!((config.r#loop.max_attempts, config.r#loop.judge.temperature), (None, 0.1));
    assert_eq!(config.compaction.threshold, 0.7);
    assert_eq!(config.archive.retention, ArchiveRetention::Weekly);
    assert!(config.remote.enabled && config.peer.enabled, "on where the system can pair");
    assert_eq!(config.micro_tasks.tasks["auto-name"].char_limit, 280);

    // What `GET /api/ui-config` answered from the defaults (fixtures/wire/recordings/20-reads.json).
    let recorded = eos_testkit_free::ui_config();
    assert_eq!(serde_json::to_value(&config.prices).expect("serializes"), recorded["prices"]);
    assert_eq!(
        config.prices.keys().collect::<Vec<_>>(),
        recorded["models"].as_array().expect("models").iter().map(|m| m.as_str().expect("a name")).collect::<Vec<_>>(),
        "in declaration order"
    );
    assert_eq!(config.permissions.default_ttl_ms, recorded["permissions"]["defaultTtlMs"]);
    assert_eq!(config.daemon.sse_keepalive_ms, recorded["sse"]["keepaliveMs"]);
    let profile = &recorded["backendProfiles"][0];
    assert_eq!(config.backends[profile["name"].as_str().expect("a name")].model, profile["model"]);
}

/// The recorded `/api/ui-config` body, read without the test kit (which sits
/// above this crate).
mod eos_testkit_free {
    use serde_json::Value;

    pub(super) fn ui_config() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/wire/recordings/20-reads.json");
        let recording: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("the recording")).expect("JSON");
        let steps = recording["exchanges"].as_array().expect("steps");
        steps.iter().find(|e| e["step"]["name"] == "ui-config").expect("the step")["response"]["json"].clone()
    }
}

#[test]
fn the_environment_overrides_a_default_and_the_file_overrides_both() {
    let env = [
        ("EOS_SSE_KEEPALIVE_MS", "1000"),
        ("EOS_REMOTE_ENABLED", "0"),
        ("EOS_EVENTS_MAX_PER_WORKER", "nope"),
        ("EOS_PEER_PORT", ""),
    ];
    let (config, _) = resolve(&host(&env), None);
    assert_eq!(config.daemon.sse_keepalive_ms, 1000);
    assert!(!config.remote.enabled);
    assert_eq!(config.events.max_per_worker, 20_000, "not a number: the default stays");
    assert_eq!(config.peer.port, 0, "an empty value reads as 0, as Number(\"\") does");

    let (config, rejected) =
        resolve(&host(&env), Some(json!({ "daemon": { "sseKeepaliveMs": 5000 }, "remote": { "enabled": true } })));
    assert_eq!(rejected, None);
    assert_eq!(config.daemon.sse_keepalive_ms, 5000);
    assert!(config.remote.enabled);
    assert!(config.remote.relay.is_some(), "the rest of the section keeps its defaults");
}

#[test]
fn sections_merge_by_their_own_rules() {
    let (config, rejected) = with_file(json!({
        "prices": {
            "opus": { "out": 80 },
            "glm-9": { "in": 1 },
            "qwen3.7-max": { "in": 2 },
            "sonnet": { "tiers": [{ "maxInputTokens": null, "price": { "in": 3, "out": 15 } }] },
        },
        "mcp": { "worker": { "exclude": ["github"] } },
        "memory": { "sources": { "claude": { "label": "Mine" }, "agents": { "projectFilenames": ["AGENTS.md"] } } },
        "backends": { "deepseek": { "kind": "openai", "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" } },
        "defaults": { "worker": { "backend": "deepseek" }, "orchestrator": {} },
        "loop": { "enabled": true, "judge": { "model": "haiku" } },
        "microTasks": { "tasks": { "auto-name": { "delayMs": 0 } } },
        "archive": { "retention": "off" },
        "workflow": { "enabled": true },
    }));
    assert_eq!(rejected, None);
    let price = |name: &str| serde_json::to_value(&config.prices[name]).expect("serializes");
    assert_eq!(
        price("opus"),
        json!({ "in": 15, "out": 80, "cacheRead": 1.5, "cacheCreate": 18.75, "cacheCreate1h": 30 })
    );
    assert_eq!(price("glm-9"), json!({ "in": 1, "out": 0, "cacheRead": 0, "cacheCreate": 0, "cacheCreate1h": 0 }));
    assert_eq!(price("qwen3.7-max")["in"], 2, "a flat override of a tiered price starts from zero");
    assert_eq!(price("sonnet")["tiers"][0]["price"]["cacheRead"], 0, "a tiered override replaces the price whole");
    assert_eq!(config.mcp.worker.exclude, ["github"]);
    assert_eq!(config.mcp.worker.include, ["*"]);
    assert_eq!(config.memory.sources["claude"].label.as_deref(), Some("Mine"));
    assert_eq!(config.memory.sources["claude"].user_paths.as_deref(), Some(&["~/.claude/CLAUDE.md".to_owned()][..]));
    assert!(config.memory.sources.contains_key("agents"));
    assert_eq!(config.backends.keys().collect::<Vec<_>>(), ["claude-opus", "deepseek"]);
    assert_eq!(
        (config.defaults.worker.backend.as_str(), config.defaults.orchestrator.backend.as_str()),
        ("deepseek", "claude-opus")
    );
    assert!(config.r#loop.enabled);
    assert_eq!((config.r#loop.judge.model.as_str(), config.r#loop.judge.temperature), ("haiku", 0.1));
    assert_eq!(
        (config.micro_tasks.tasks["auto-name"].delay_ms, config.micro_tasks.tasks["auto-name"].char_limit),
        (0, 280)
    );
    assert_eq!(config.archive.retention, ArchiveRetention::Off);
    assert!(!config.archive.purge_on_app_close);
}

#[test]
fn a_file_that_breaks_a_rule_is_ignored_whole() {
    for bad in [
        json!({ "archive": { "retention": "hourly" }, "loop": { "enabled": true } }),
        json!({ "compaction": { "threshold": 2 } }),
        json!({ "prices": { "opus": { "input": 1 } } }),
        json!({ "daemon": { "sseKeepaliveMs": 0 } }),
        json!({ "updates": { "feedUrl": "http://plain.example/feed" } }),
        json!({ "microTasks": { "tasks": { "new-task": { "enabled": true } } } }),
        json!(["not", "an", "object"]),
    ] {
        let (config, rejected) = with_file(bad.clone());
        assert!(rejected.is_some(), "{bad}");
        assert_eq!(config, resolve(&host(&[]), None).0, "{bad}: the defaults stand");
    }
}

#[test]
fn files_of_older_versions_are_read_in_todays_terms() {
    let (config, rejected) = with_file(json!({
        "remote": { "mode": "relay", "relay": { "url": "wss://relay.example/", "token": "old" }, "lan": { "port": 1 } },
        "backends": {
            "claude-sdk": { "kind": "claude-sdk", "model": "claude-opus-5-5" },
            "claude-cli-sonnet": { "kind": "claude-cli", "model": "claude-sonnet-5-5" },
        },
        "defaults": { "orchestrator": { "backend": "claude-sdk-opus" }, "worker": { "backend": "claude-cli-sonnet" } },
    }));
    assert_eq!(rejected, None);
    assert!(config.remote.enabled);
    assert_eq!(config.remote.relay.as_ref().map(|r| r.url.as_str()), Some("wss://relay.example/"));
    assert_eq!(serde_json::to_value(config.backends["claude-sdk"].kind).expect("serializes"), "claude");
    assert!(config.backends.contains_key("claude-sonnet") && !config.backends.contains_key("claude-cli-sonnet"));
    assert_eq!(config.defaults.orchestrator.backend, "claude-opus");
    assert_eq!(config.defaults.worker.backend, "claude-sonnet");

    let (off, _) = with_file(json!({ "remote": { "mode": "off" } }));
    assert!(!off.remote.enabled);
}

#[test]
fn a_model_is_priced_by_name_then_by_family() {
    let (config, _) = resolve(&host(&[]), None);
    let rate = |model: Option<&str>| {
        price_for_model(&config, model).map(|p| serde_json::to_value(p).expect("serializes")["in"].clone())
    };
    assert_eq!(rate(Some("glm-5.2")), Some(json!(1.4)));
    assert_eq!(rate(Some("claude-opus-5-5")), Some(json!(15)));
    assert_eq!(rate(Some("Claude-Haiku-5")), Some(json!(1)));
    assert_eq!(rate(None), Some(json!(15)), "no model: opus");
    assert_eq!(rate(Some("gpt-9")), None);
}
