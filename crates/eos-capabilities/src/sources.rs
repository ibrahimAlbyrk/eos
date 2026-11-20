//! The signal sources the built-in capabilities declare (`[[sources]]`):
//! each poll is a call of the source's action with the routine's scope and
//! the cursor, kept opaque and handed back as the action gave it. What a
//! source sees came from outside: every item it hands a run is marked so.

use std::sync::Arc;

use eos_contracts::{Facts, ItemRef};
use eos_core::BoxFuture;
use eos_core::capability::{ActionCall, ActionCaller, ActionError, FailureKind};
use eos_core::signals::{
    FactDecl, PollPage, PollRequest, PushEvent, PushOutcome, Scope, SignalDraft, SignalSource, SignalSources,
    SourceError,
};
use eos_domain::capability::health::StateCode;
use eos_domain::capability::manifest::Source as SourceDecl;
use serde_json::{Map, Value};

use crate::CapabilityService;

/// The sources of the built-ins, by `<capability>.<source>`
/// (`github.pulls`).
pub(crate) struct Sources(pub(crate) Arc<CapabilityService>);

impl SignalSources for Sources {
    fn get(&self, source: &str) -> Option<Arc<dyn SignalSource>> {
        let (capability, name) = source.split_once('.')?;
        let builtin = self.0.builtins.get(capability)?;
        let decl = builtin.manifest().sources.iter().find(|decl| decl.name == name)?.clone();
        let facts = decl.facts.iter().map(|(name, kind)| FactDecl { name: name.clone(), kind: *kind }).collect();
        Some(Arc::new(Source { service: self.0.clone(), capability: capability.to_owned(), decl, facts }))
    }
}

struct Source {
    service: Arc<CapabilityService>,
    capability: String,
    decl: SourceDecl,
    facts: Vec<FactDecl>,
}

/// The key of one thing a source saw: the item at its version, and what
/// happened when that is more than a change (`…@<sha>:closed`).
fn signal_key(key: &str, version: Option<&str>, event: &str) -> String {
    let mut signal = key.to_owned();
    if let Some(version) = version {
        signal.push('@');
        signal.push_str(version);
    }
    if !matches!(event, "opened" | "updated") {
        signal.push(':');
        signal.push_str(event);
    }
    signal
}

/// What a failed call of a source's action tells the poll. A capability
/// that lost what the source reads says so before any call goes out.
fn failed(error: &ActionError, now: i64) -> SourceError {
    let signed_out = |code: &str| {
        matches!(
            StateCode::parse(code),
            Some(StateCode::Http401 | StateCode::SecretMissing(_) | StateCode::ClientIdMissing)
        )
    };
    match error {
        ActionError::RateLimited { retry_after_s } => {
            let wait_ms = i64::try_from(*retry_after_s).unwrap_or(i64::MAX / 2_000).saturating_mul(1000);
            SourceError::RateLimited { retry_at: now.saturating_add(wait_ms) }
        }
        ActionError::Failed { kind: FailureKind::Unauthorized } => SourceError::Unauthorized,
        ActionError::NotReady(code) if signed_out(code) => SourceError::Unauthorized,
        ActionError::NotReady(code) if StateCode::parse(code) == Some(StateCode::SourceGone) => SourceError::Gone,
        ActionError::Failed { kind: FailureKind::Gone } => SourceError::Gone,
        ActionError::Invalid(_) => SourceError::Bad("scope"),
        ActionError::NotFound => SourceError::Bad("source"),
        ActionError::Failed { kind: FailureKind::Output } => SourceError::Bad("output"),
        _ => SourceError::Unreachable,
    }
}

impl Source {
    /// One item of the action's answer as a signal draft.
    fn draft(&self, item: &Value) -> Option<SignalDraft> {
        let key = item["key"].as_str().filter(|key| !key.is_empty())?;
        let version = item["version"].as_str().filter(|version| !version.is_empty());
        let event = item["event"].as_str().unwrap_or("updated");
        let facts: Facts = serde_json::from_value(item["facts"].clone()).unwrap_or_default();
        let text = |field: &str| item[field].as_str().map(str::to_owned);
        let run_item = ItemRef {
            kind: self.decl.item.clone(),
            key: Some(version.map_or_else(|| key.to_owned(), |version| format!("{key}@{version}"))),
            title: text("title"),
            url: text("url"),
            path: None,
            text: None,
            date: None,
            range: None,
            version: version.map(str::to_owned),
            // A service's text: whoever runs on it reads it as outside text.
            untrusted: true,
        };
        Some(SignalDraft {
            key: signal_key(key, version, event),
            subject: key.to_owned(),
            version: version.map(str::to_owned),
            kind: event.to_owned(),
            occurred_at: item["updatedAt"].as_i64().unwrap_or_default(),
            facts,
            item: serde_json::to_value(run_item).ok()?,
        })
    }

    async fn poll_once(&self, request: PollRequest) -> Result<PollPage, SourceError> {
        let mut input: Map<String, Value> =
            request.scope.iter().map(|(name, value)| (name.clone(), Value::String(value.clone()))).collect();
        if let Some(cursor) = request.cursor {
            input.insert("cursor".into(), cursor);
        }
        let call = ActionCall {
            capability: self.capability.clone(),
            action: self.decl.action.clone(),
            input: Value::Object(input),
            caller: ActionCaller::Source,
            idempotency_key: None,
        };
        let output =
            self.service.run_call(call).await.map_err(|e| failed(&e, self.service.ports.clock.now_ms()))?.output;
        let items = output["items"].as_array().into_iter().flatten().filter_map(|item| self.draft(item)).collect();
        Ok(PollPage {
            items,
            cursor: output["cursor"].clone(),
            more: false,
            baseline: output["baseline"].as_bool().unwrap_or(false),
            poll_after_ms: output["pollAfterS"].as_i64().map(|s| s.saturating_mul(1000)),
            retry_at: None,
        })
    }
}

impl SignalSource for Source {
    fn facts(&self) -> &[FactDecl] {
        &self.facts
    }

    fn interval_ms(&self) -> Option<i64> {
        self.decl.interval_s.map(|s| i64::from(s) * 1000)
    }

    fn poll(&self, request: PollRequest) -> BoxFuture<'_, Result<PollPage, SourceError>> {
        Box::pin(self.poll_once(request))
    }

    fn accept_push(&self, _scope: &Scope, _event: &PushEvent) -> Result<PushOutcome, SourceError> {
        // No source checks a push's signature yet: none is taken.
        Ok(PushOutcome::Refused)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signal_is_keyed_by_its_item_at_its_version_and_what_happened_beyond_a_change() {
        assert_eq!(signal_key("github:pr:acme/game#7", Some("abc"), "opened"), "github:pr:acme/game#7@abc");
        assert_eq!(signal_key("github:pr:acme/game#7", Some("abc"), "updated"), "github:pr:acme/game#7@abc");
        assert_eq!(signal_key("github:pr:acme/game#7", Some("abc"), "ready"), "github:pr:acme/game#7@abc:ready");
        assert_eq!(signal_key("github:pr:acme/game#7", None, "closed"), "github:pr:acme/game#7:closed");
    }

    #[test]
    fn a_capability_that_lost_what_its_source_reads_says_the_source_is_gone() {
        assert_eq!(failed(&ActionError::NotReady("source_gone".into()), 0), SourceError::Gone);
        assert_eq!(failed(&ActionError::NotReady("http_401".into()), 0), SourceError::Unauthorized);
        assert_eq!(
            failed(&ActionError::RateLimited { retry_after_s: 2 }, 10),
            SourceError::RateLimited { retry_at: 2_010 }
        );
    }
}
