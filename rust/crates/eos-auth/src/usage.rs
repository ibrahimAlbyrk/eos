//! Claude's plan-usage endpoint, the snapshot file and the setup-token check
//! (`infra/src/usage/ClaudeUsageProvider.ts`, `FileUsageSnapshotStore.ts`,
//! `infra/src/auth/claudeTokenProbe.ts`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{ModelUsageWindow, ProviderUsage, ProviderUsageExtraUsage, ProviderUsageWindows, UsageWindow};
use eos_core::accounts::{PlanUsageApi, TokenProbe, TokenProbeResult, UsageSnapshotStore};
use eos_core::{BoxFuture, Clock, Error};
use eos_domain::time::iso_from_ms;
use eos_kit_fs::{WriteOptions, atomic_write};
use eos_kit_net::{ClientOptions, http_client};
use serde_json::Value;

const ANTHROPIC_API: &str = "https://api.anthropic.com";
/// Eos names itself: it does not pose as another program.
const USER_AGENT: &str = concat!("eos/", env!("CARGO_PKG_VERSION"));
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// How much of an upstream error body is shown.
const DETAIL_CHARS: usize = 300;

fn client() -> reqwest::Client {
    // The options are constants; a client that cannot be built is a broken TLS set-up.
    http_client(&ClientOptions::new(USER_AGENT)).unwrap_or_default()
}

/// The undocumented OAuth usage endpoint the Claude apps read.
pub struct ClaudeUsageApi {
    http: reqwest::Client,
    base: String,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for ClaudeUsageApi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeUsageApi").field("base", &self.base).finish_non_exhaustive()
    }
}

impl ClaudeUsageApi {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self::at(ANTHROPIC_API, clock)
    }

    /// `base`: the API's origin (a local server in tests).
    pub fn at(base: impl Into<String>, clock: Arc<dyn Clock>) -> Self {
        Self { http: client(), base: base.into(), clock }
    }
}

/// Utilization arrives on a 0–100 scale already: clamped, never rescaled.
fn clamp(utilization: f64) -> f64 {
    if utilization.is_finite() { utilization.clamp(0.0, 100.0) } else { 0.0 }
}

/// A window needs a numeric utilization; one without a reset time has not
/// started yet (the idle five-hour window reports 0% and no reset).
fn window(utilization: Option<&Value>, resets_at: Option<&Value>, severity: Option<&Value>) -> Option<UsageWindow> {
    Some(UsageWindow {
        utilization: clamp(utilization?.as_f64()?).into(),
        resets_at: resets_at.and_then(Value::as_str).map(str::to_owned),
        severity: severity.and_then(Value::as_str).map(str::to_owned),
    })
}

/// The endpoint's answer as a snapshot. `limits[]` grades every limit of the
/// account (`session`, `weekly_all`, `weekly_scoped`): it carries the
/// severity of the two windows and is the only source of per-model weekly
/// limits.
fn snapshot(data: &Value, fetched_at: String) -> ProviderUsage {
    let limits: Vec<&Value> =
        data.get("limits").and_then(Value::as_array).map(|l| l.iter().collect()).unwrap_or_default();
    let slot =
        |key: &str, kind: &str| {
            let raw = data.get(key).filter(|v| v.is_object());
            let severity = limits.iter().find(|l| l.get("kind").and_then(Value::as_str) == Some(kind));
            Some(raw.and_then(|r| {
                window(r.get("utilization"), r.get("resets_at"), severity.and_then(|l| l.get("severity")))
            }))
        };
    let weekly_by_model: Vec<ModelUsageWindow> = limits
        .iter()
        .filter(|l| l.get("kind").and_then(Value::as_str) == Some("weekly_scoped"))
        .filter_map(|l| {
            let model = l.get("scope")?.get("model")?.get("display_name")?.as_str()?;
            let w = window(l.get("percent"), l.get("resets_at"), l.get("severity"))?;
            Some(ModelUsageWindow {
                utilization: w.utilization,
                resets_at: w.resets_at,
                severity: w.severity,
                model: model.to_owned(),
            })
        })
        .collect();
    // Credit amounts arrive in minor units of the currency, `decimal_places` saying how many.
    let extra_usage = data.get("extra_usage").filter(|v| v.is_object()).map(|extra| {
        let places = extra.get("decimal_places").and_then(Value::as_f64).unwrap_or(2.0);
        let major = |key: &str| Some(extra.get(key).and_then(Value::as_f64).map(|v| (v / 10f64.powf(places)).into()));
        ProviderUsageExtraUsage {
            is_enabled: extra.get("is_enabled").and_then(Value::as_bool) == Some(true),
            used_credits: major("used_credits"),
            monthly_limit: major("monthly_limit"),
            currency: Some(extra.get("currency").and_then(Value::as_str).unwrap_or("USD").to_owned()),
        }
    });
    ProviderUsage {
        provider: "claude".to_owned(),
        login_id: None,
        label: None,
        plan: None,
        windows: ProviderUsageWindows {
            five_hour: slot("five_hour", "session"),
            seven_day: slot("seven_day", "weekly_all"),
            weekly_by_model: (!weekly_by_model.is_empty()).then_some(weekly_by_model),
        },
        extra_usage,
        fetched_at,
        stale: None,
    }
}

impl PlanUsageApi for ClaudeUsageApi {
    fn fetch<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<ProviderUsage, String>> {
        Box::pin(async move {
            let request = self
                .http
                .get(format!("{}/api/oauth/usage", self.base))
                .bearer_auth(token)
                .header("anthropic-beta", "oauth-2025-04-20")
                .header("content-type", "application/json");
            let res = request.send().await.map_err(|e| format!("usage request failed: {e}"))?;
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            if !status.is_success() {
                // The upstream message (a scope requirement, a 429) as it came, capped.
                let detail: String = body.chars().take(DETAIL_CHARS).collect();
                let detail = if detail.is_empty() { String::new() } else { format!(": {detail}") };
                return Err(format!("usage fetch failed (HTTP {}){detail}", status.as_u16()));
            }
            let data: Value = serde_json::from_str(&body).map_err(|e| format!("usage request failed: {e}"))?;
            Ok(snapshot(&data, iso_from_ms(self.clock.now_ms())))
        })
    }
}

/// Is a Claude bearer token still accepted? One cheap authenticated read.
/// Only a 401 means rejected: anything else that is not a success (the
/// network, a 429, a server error) is unknown, so a flaky connection never
/// shows a signed-in user as expired.
pub struct ClaudeTokenProbe {
    http: reqwest::Client,
    base: String,
}

impl std::fmt::Debug for ClaudeTokenProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeTokenProbe").field("base", &self.base).finish_non_exhaustive()
    }
}

impl Default for ClaudeTokenProbe {
    fn default() -> Self {
        Self::at(ANTHROPIC_API)
    }
}

impl ClaudeTokenProbe {
    pub fn at(base: impl Into<String>) -> Self {
        Self { http: client(), base: base.into() }
    }
}

impl TokenProbe for ClaudeTokenProbe {
    fn probe<'a>(&'a self, token: &'a str) -> BoxFuture<'a, TokenProbeResult> {
        Box::pin(async move {
            let request = self
                .http
                .get(format!("{}/v1/models?limit=1", self.base))
                .bearer_auth(token)
                .header("anthropic-version", "2023-06-01")
                .timeout(PROBE_TIMEOUT);
            match request.send().await {
                Ok(res) if res.status().as_u16() == 401 => TokenProbeResult::Rejected,
                Ok(res) if res.status().is_success() => TokenProbeResult::Valid,
                _ => TokenProbeResult::Unknown,
            }
        })
    }
}

/// The last good plan-usage snapshot per provider, as one JSON file in the
/// data folder (`usage-cache.json`). Regenerable: a missing or unreadable
/// file only means the next fetch starts from nothing.
#[derive(Debug)]
pub struct FileUsageSnapshots {
    file: PathBuf,
}

impl FileUsageSnapshots {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self { file: file.into() }
    }
}

impl UsageSnapshotStore for FileUsageSnapshots {
    fn load(&self) -> Vec<ProviderUsage> {
        let raw: Option<Value> = std::fs::read(&self.file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
        match raw {
            Some(Value::Array(entries)) => entries.iter().filter_map(|e| eos_contracts::parse(e).ok()).collect(),
            _ => Vec::new(),
        }
    }

    fn save(&self, snapshots: &[ProviderUsage]) -> Result<(), Error> {
        let text = serde_json::to_string(snapshots).map_err(Error::storage)?;
        atomic_write(&self.file, text.as_bytes(), &WriteOptions::default()).map_err(Error::storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // What the endpoint answers, shaped as infra/src/__tests__/ClaudeUsageProvider.test.ts feeds it.
    #[test]
    fn the_endpoints_answer_becomes_a_snapshot() {
        let data = serde_json::json!({
            "five_hour": { "utilization": 41.0, "resets_at": "2026-06-08T14:00:00Z" },
            "seven_day": { "utilization": 159.0, "resets_at": null },
            "seven_day_opus": null,
            "limits": [
                { "kind": "session", "percent": 41, "severity": "normal" },
                { "kind": "weekly_all", "percent": 59, "severity": "warning" },
                { "kind": "weekly_scoped", "percent": 12.5, "resets_at": "2026-06-10T00:00:00Z", "severity": "normal",
                  "scope": { "model": { "display_name": "Fable" } } },
                { "kind": "weekly_scoped", "percent": "n/a", "scope": { "model": { "display_name": "Broken" } } },
            ],
            "extra_usage": { "is_enabled": true, "used_credits": 1234, "monthly_limit": null, "decimal_places": 2 },
        });
        let usage = snapshot(&data, "2026-06-08T10:00:00.000Z".into());
        assert_eq!(
            serde_json::to_value(&usage).expect("JSON"),
            serde_json::json!({
                "provider": "claude",
                "windows": {
                    "fiveHour": { "utilization": 41, "resetsAt": "2026-06-08T14:00:00Z", "severity": "normal" },
                    "sevenDay": { "utilization": 100, "resetsAt": null, "severity": "warning" },
                    "weeklyByModel": [
                        { "utilization": 12.5, "resetsAt": "2026-06-10T00:00:00Z", "severity": "normal", "model": "Fable" },
                    ],
                },
                "extraUsage": { "isEnabled": true, "usedCredits": 12.34, "monthlyLimit": null, "currency": "USD" },
                "fetchedAt": "2026-06-08T10:00:00.000Z",
            })
        );

        // Windows the provider does not report are null; no extra usage, no key.
        let bare = snapshot(&serde_json::json!({ "five_hour": null }), "t".into());
        assert_eq!(
            serde_json::to_value(&bare).expect("JSON"),
            serde_json::json!({ "provider": "claude", "windows": { "fiveHour": null, "sevenDay": null }, "fetchedAt": "t" })
        );
    }

    // infra/src/__tests__/FileUsageSnapshotStore.test.ts
    #[test]
    fn snapshots_survive_a_restart_and_a_broken_file_reads_empty() {
        let home = eos_testkit::TempHome::new();
        let store = FileUsageSnapshots::new(home.join("usage-cache.json"));
        assert!(store.load().is_empty());
        let usage =
            snapshot(&serde_json::json!({ "five_hour": { "utilization": 7 } }), "2026-06-08T10:00:00.000Z".into());
        let mine = ProviderUsage { login_id: Some("lg-1".into()), label: Some("Work".into()), ..usage };
        store.save(std::slice::from_ref(&mine)).expect("saves");
        assert_eq!(store.load(), [mine]);
        assert!(home.read("usage-cache.json").starts_with(r#"[{"provider":"claude","loginId":"lg-1","label":"Work","#));

        home.write("usage-cache.json", r#"[{"provider":"claude"},{"provider":"codex","windows":{},"fetchedAt":"t"}]"#);
        assert_eq!(store.load().len(), 1, "an entry that is not a snapshot is skipped");
        home.write("usage-cache.json", "{nope");
        assert!(store.load().is_empty());
    }
}
