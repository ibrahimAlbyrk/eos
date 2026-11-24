//! The signal sources the built-in capabilities declare (`[[sources]]`):
//! each poll is a call of the source's action with the routine's scope and
//! the cursor, kept opaque and handed back as the action gave it. What a
//! source sees came from outside: every item it hands a run is marked so.
//!
//! A source whose manifest declares `push` can also be told of news by its
//! service (06 G36): adding push keeps a random secret for the hook as
//! `webhook.<hook>` (`eos-cap.<capability>.webhook.<hook>` in the app
//! Keychain) and calls the capability's `create_webhook` with it. A push is
//! taken only when its signature checks out with that secret, and even then
//! it is a hint to poll: signals come only from the source's own reads.

use std::sync::Arc;

use eos_contracts::{Facts, ItemRef};
use eos_core::BoxFuture;
use eos_core::capability::{ActionCall, ActionCaller, ActionError, FailureKind, PushSecret};
use eos_core::net::hooks::HookUrl;
use eos_core::signals::{
    FactDecl, PollPage, PollRequest, PushEvent, PushOutcome, Scope, SignalDraft, SignalSource, SignalSources,
    SourceError,
};
use eos_domain::capability::health::StateCode;
use eos_domain::capability::manifest::{Push, Source as SourceDecl, Verify};
use hmac::{KeyInit, Mac};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

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

/// The action that registers a webhook with the service.
const CREATE_WEBHOOK: &str = "create_webhook";

/// The secret a hook's pushes are signed with, by its name in the Keychain.
fn webhook_secret(hook: &str) -> String {
    format!("webhook.{hook}")
}

fn fresh_secret() -> Result<Zeroizing<String>, SourceError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| SourceError::Bad("random"))?;
    Ok(Zeroizing::new(bytes.iter().map(|b| format!("{b:02x}")).collect()))
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

/// Whether `event` carries the signature `push` names, made with `secret`
/// over its body. The comparison takes the same time wherever it differs.
fn signed(push: &Push, secret: &str, event: &PushEvent) -> bool {
    let header = event.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case(&push.signature_header));
    let Some(signature) = header.and_then(|(_, value)| value.trim().strip_prefix("sha256=")).and_then(unhex) else {
        return false;
    };
    match push.verify {
        Verify::HmacSha256 => {
            let Ok(mut mac) = <hmac::Hmac<sha2::Sha256> as KeyInit>::new_from_slice(secret.as_bytes()) else {
                return false;
            };
            mac.update(&event.body);
            mac.verify_slice(&signature).is_ok()
        }
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
            // A message source hands what the message says; others leave it to the run.
            text: text("text"),
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

    fn closes(&self, kind: &str) -> bool {
        self.decl.closing.iter().any(|closing| closing == kind)
    }

    fn poll(&self, request: PollRequest) -> BoxFuture<'_, Result<PollPage, SourceError>> {
        Box::pin(self.poll_once(request))
    }

    fn accept_push<'a>(
        &'a self,
        _scope: &'a Scope,
        event: &'a PushEvent,
    ) -> BoxFuture<'a, Result<PushOutcome, SourceError>> {
        Box::pin(async move {
            let Some(push) = &self.decl.push else { return Ok(PushOutcome::Refused) };
            let secret = self.service.ports.secrets.read(&self.capability, &webhook_secret(&event.hook)).await;
            let secret = secret.map_err(|_| SourceError::Unreachable)?;
            // A hook this Mac keeps no secret for was never this source's.
            let Some(secret) = secret else { return Ok(PushOutcome::Refused) };
            Ok(if signed(push, &secret, event) { PushOutcome::PollNow { focus: None } } else { PushOutcome::Refused })
        })
    }

    fn pushes(&self) -> bool {
        self.decl.push.is_some()
    }

    fn add_push<'a>(&'a self, scope: &'a Scope, hook: &'a HookUrl) -> BoxFuture<'a, Result<(), SourceError>> {
        Box::pin(async move {
            if self.decl.push.is_none() {
                return Err(SourceError::Bad("push"));
            }
            let name = webhook_secret(&hook.id);
            let secret = fresh_secret()?;
            let secrets = &self.service.ports.secrets;
            secrets.write(&self.capability, &name, secret.clone()).await.map_err(|_| SourceError::Unreachable)?;
            let mut input: Map<String, Value> =
                scope.iter().map(|(name, value)| (name.clone(), Value::String(value.clone()))).collect();
            input.insert("url".into(), Value::String(hook.url.clone()));
            let call = ActionCall {
                capability: self.capability.clone(),
                action: CREATE_WEBHOOK.to_owned(),
                input: Value::Object(input),
                caller: ActionCaller::Push { secret: PushSecret(secret) },
                idempotency_key: None,
            };
            match self.service.run_call(call).await {
                Ok(_) => Ok(()),
                Err(error) => {
                    // The service never took it: no push will be signed with this secret.
                    let _ = secrets.delete(&self.capability, &name).await;
                    Err(failed(&error, self.service.ports.clock.now_ms()))
                }
            }
        })
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

    fn push() -> Push {
        Push {
            verify: Verify::HmacSha256,
            signature_header: "X-Hub-Signature-256".into(),
            delivery_header: "X-GitHub-Delivery".into(),
        }
    }

    fn event(signature: &str, body: &[u8]) -> PushEvent {
        PushEvent {
            hook: "h1".into(),
            headers: vec![("x-hub-signature-256".into(), signature.into()), ("x-github-delivery".into(), "d1".into())],
            body: body.to_vec(),
        }
    }

    #[test]
    fn a_push_is_signed_only_with_the_hooks_secret_over_its_exact_body() {
        // GitHub's own example (docs: validating webhook deliveries).
        let good = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        assert!(signed(&push(), "It's a Secret to Everybody", &event(good, b"Hello, World!")));
        assert!(!signed(&push(), "It's a Secret to Everybody", &event(good, b"Hello, World?")));
        assert!(!signed(&push(), "another secret", &event(good, b"Hello, World!")));
        assert!(!signed(&push(), "It's a Secret to Everybody", &event(&good.replace("sha256=", ""), b"Hello, World!")));
        assert!(!signed(&push(), "It's a Secret to Everybody", &event("sha256=zz", b"Hello, World!")));
        let unsigned = PushEvent { headers: Vec::new(), ..event(good, b"Hello, World!") };
        assert!(!signed(&push(), "It's a Secret to Everybody", &unsigned));
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
