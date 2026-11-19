//! The code behind capabilities, scripted: a built-in, the runner of
//! packages, the registry as the policy reads it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use eos_contracts::ActionClass;
use eos_core::capability::{
    ActionContext, ActionError, ActionRunner, BuiltinCapability, Capability, CapabilityRegistry, Package,
};
use eos_core::{BoxFuture, Error};
use eos_domain::capability::health::{Event, Health};
use eos_domain::capability::manifest::{Manifest, parse};
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// One call a [`FakeBuiltin`] took: secret names only, never values.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltinCall {
    pub action: String,
    pub input: Value,
    pub secrets: Vec<String>,
    pub idempotency_key: Option<String>,
}

/// A built-in capability from a manifest the test writes: each action
/// answers what the test set (`{}` until then), its health check finds what
/// the test set ([`Event::Passed`] until then). Held, each call waits until
/// the test releases it.
#[derive(Debug)]
pub struct FakeBuiltin {
    manifest: Manifest,
    answers: Mutex<HashMap<String, Result<Value, ActionError>>>,
    health: Mutex<Event>,
    calls: Mutex<Vec<BuiltinCall>>,
    gate: Option<Arc<Semaphore>>,
}

impl FakeBuiltin {
    /// `manifest`: a `capability.toml` with `form = "builtin"`.
    pub fn new(manifest: &str) -> Self {
        Self {
            manifest: parse(manifest).expect("a manifest"),
            answers: Mutex::default(),
            health: Mutex::new(Event::Passed),
            calls: Mutex::default(),
            gate: None,
        }
    }

    pub fn answering(self, action: &str, answer: Result<Value, ActionError>) -> Self {
        self.answer(action, answer);
        self
    }

    pub fn answer(&self, action: &str, answer: Result<Value, ActionError>) {
        locked(&self.answers).insert(action.to_owned(), answer);
    }

    pub fn set_health(&self, event: Event) {
        *locked(&self.health) = event;
    }

    /// Every call waits for [`release`](Self::release).
    pub fn held(mut self) -> Self {
        self.gate = Some(Arc::new(Semaphore::new(0)));
        self
    }

    /// Lets `n` held calls go on.
    pub fn release(&self, n: usize) {
        if let Some(gate) = &self.gate {
            gate.add_permits(n);
        }
    }

    /// The calls it took, held ones included, in order.
    pub fn calls(&self) -> Vec<BuiltinCall> {
        locked(&self.calls).clone()
    }
}

impl BuiltinCapability for FakeBuiltin {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        action: &'a str,
        input: Value,
        ctx: &'a ActionContext,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        let mut secrets: Vec<String> = ctx.secrets.keys().cloned().collect();
        secrets.sort();
        let idempotency_key = ctx.idempotency_key.clone();
        locked(&self.calls).push(BuiltinCall { action: action.to_owned(), input, secrets, idempotency_key });
        Box::pin(async move {
            if let Some(gate) = &self.gate {
                gate.acquire().await.expect("the gate stays open").forget();
            }
            locked(&self.answers).get(action).cloned().unwrap_or_else(|| Ok(json!({})))
        })
    }

    fn health<'a>(&'a self, _ctx: &'a ActionContext) -> BoxFuture<'a, Event> {
        Box::pin(std::future::ready(locked(&self.health).clone()))
    }
}

/// One run a [`FakeActionRunner`] took: environment names only.
#[derive(Debug, Clone, PartialEq)]
pub struct RunnerCall {
    pub capability: String,
    pub version: String,
    pub action: String,
    pub input: Value,
    pub env: Vec<String>,
    pub timeout: Duration,
}

/// Runs nothing: each package action answers what the test set (`{}` until
/// then). Records every run and every stop.
#[derive(Debug, Default)]
pub struct FakeActionRunner {
    answers: Mutex<HashMap<(String, String), Result<Value, ActionError>>>,
    runs: Mutex<Vec<RunnerCall>>,
    stopped: Mutex<Vec<String>>,
}

impl FakeActionRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn answering(self, capability: &str, action: &str, answer: Result<Value, ActionError>) -> Self {
        locked(&self.answers).insert((capability.to_owned(), action.to_owned()), answer);
        self
    }

    pub fn runs(&self) -> Vec<RunnerCall> {
        locked(&self.runs).clone()
    }

    /// The capabilities stopped, in order.
    pub fn stopped(&self) -> Vec<String> {
        locked(&self.stopped).clone()
    }
}

impl ActionRunner for FakeActionRunner {
    fn run<'a>(
        &'a self,
        package: &'a Package,
        action: &'a str,
        input: Value,
        env: Vec<(String, Zeroizing<String>)>,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        locked(&self.runs).push(RunnerCall {
            capability: package.id.clone(),
            version: package.version.clone(),
            action: action.to_owned(),
            input,
            env: env.into_iter().map(|(name, _)| name).collect(),
            timeout,
        });
        let key = (package.id.clone(), action.to_owned());
        let answer = locked(&self.answers).get(&key).cloned().unwrap_or_else(|| Ok(json!({})));
        Box::pin(std::future::ready(answer))
    }

    fn stop<'a>(&'a self, id: &'a str) -> BoxFuture<'a, ()> {
        locked(&self.stopped).push(id.to_owned());
        Box::pin(std::future::ready(()))
    }
}

/// The capabilities the test gives, as the registry answers them.
#[derive(Debug, Default)]
pub struct FakeCapabilityRegistry {
    capabilities: Mutex<Vec<Capability>>,
}

impl FakeCapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A built-in from `manifest` (a `capability.toml`), in `health`.
    pub fn with(self, manifest: &str, health: Health) -> Self {
        let manifest = parse(manifest).expect("a manifest");
        locked(&self.capabilities).push(Capability {
            id: manifest.id.clone(),
            origin: "builtin".to_owned(),
            version: None,
            manifest,
            health,
            settings: json!({}),
            account_label: None,
        });
        self
    }

    fn find(&self, id: &str) -> Option<Capability> {
        locked(&self.capabilities).iter().find(|capability| capability.id == id).cloned()
    }
}

impl CapabilityRegistry for FakeCapabilityRegistry {
    fn list(&self) -> BoxFuture<'_, Result<Vec<Capability>, Error>> {
        Box::pin(std::future::ready(Ok(locked(&self.capabilities).clone())))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Capability>, Error>> {
        Box::pin(std::future::ready(Ok(self.find(id))))
    }

    fn class_of<'a>(&'a self, id: &'a str, action: &'a str) -> BoxFuture<'a, Result<Option<ActionClass>, Error>> {
        let class = self.find(id).and_then(|capability| capability.manifest.action(action).map(|a| a.class));
        Box::pin(std::future::ready(Ok(class)))
    }

    fn state<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Health>, Error>> {
        Box::pin(std::future::ready(Ok(self.find(id).map(|capability| capability.health))))
    }
}
