//! One call, from finding the action to the row that records it.

use std::collections::HashMap;
use std::time::Duration;

use eos_contracts::{ActionClass, Issue, Issues};
use eos_core::capability::{
    ActionCall, ActionCaller, ActionContext, ActionError, ActionResult, FailureKind, Grant, Package, WEBHOOK_SECRET,
};
use eos_core::store::StoredCall;
use eos_domain::capability::health::{Event, StateCode};
use eos_domain::capability::manifest::Action;
use eos_domain::capability::schema::{compile, input_error};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::CapabilityService;
use crate::health::{apply, event_of};
use crate::output::finish;
use crate::registry::Loaded;

/// How much an action may do, from reading up.
fn rank(class: ActionClass) -> u8 {
    match class {
        ActionClass::Read => 0,
        ActionClass::WriteLocal => 1,
        ActionClass::TellUser => 2,
        ActionClass::Speak => 3,
        ActionClass::Irreversible => 4,
    }
}

/// Whether `grant` lets its worker call `action` of `capability`.
pub(crate) fn allows(grant: &Grant, capability: &str, action: &Action) -> bool {
    rank(action.class) <= rank(grant.max_class)
        && grant.actions.iter().any(|granted| granted.capability == capability && granted.action == action.name)
}

/// What `value` breaks of the declared `schema`.
pub(crate) fn issues(schema: &Value, value: &Value) -> Vec<Issue> {
    match compile(schema) {
        Ok(schema) => {
            let mut cx = Issues::default();
            schema.check(value, &mut cx);
            cx.into_vec()
        }
        Err(issues) => issues,
    }
}

impl CapabilityService {
    pub(crate) async fn run_call(&self, call: ActionCall) -> Result<ActionResult, ActionError> {
        let started = self.ports.clock.now_ms();
        let loaded = match self.load_one(&call.capability).await {
            Ok(Some(loaded)) => loaded,
            Ok(None) => return Err(ActionError::NotFound),
            Err(e) => {
                // The id is the caller's input until a row is found: never logged.
                tracing::warn!(error = %e, "the capabilities could not be read");
                return Err(ActionError::Failed { kind: FailureKind::Internal });
            }
        };
        let Some(action) = loaded.capability.manifest.action(&call.action).cloned() else {
            return Err(ActionError::NotFound);
        };
        let call_id = self.ports.ids.uuid();
        let attempt = self.attempt(&loaded, &action, &call).await;
        self.record(&loaded, &action, &call, &call_id, started, &attempt).await;
        attempt.0.map(|output| ActionResult { call_id, output })
    }

    /// Steps 2 to 8 of a call: the output as the caller gets it, and what
    /// the run told of the capability's health.
    async fn attempt(
        &self,
        loaded: &Loaded,
        action: &Action,
        call: &ActionCall,
    ) -> (Result<Value, ActionError>, Option<Event>) {
        let capability = &loaded.capability;
        if let Err(e) = self.granted(&capability.id, action, &call.caller).await {
            return (Err(e), None);
        }
        if !capability.health.state.takes_calls() {
            return (Err(ActionError::not_ready(capability.health.state, capability.health.code.as_ref())), None);
        }
        if let Some(schema) = &action.input {
            let issues = issues(schema, &call.input);
            if !issues.is_empty() {
                return (Err(ActionError::Invalid(input_error(&capability.id, &action.name, &issues))), None);
            }
        }
        let _slot = match self.limits.acquire(&capability.id).await {
            Ok(slot) => slot,
            Err(e) => return (Err(e), None),
        };
        let secrets = match self.secrets_of(&capability.manifest).await {
            Ok(secrets) => secrets,
            Err(e) => {
                let event = event_of(&e);
                return (Err(e), event);
            }
        };
        let values: Vec<Zeroizing<String>> = secrets.values().cloned().collect();
        let answered = self.execute(loaded, action, call, secrets).await.and_then(|output| {
            let fits = action.output.as_ref().is_none_or(|schema| issues(schema, &output).is_empty());
            if fits { Ok(output) } else { Err(ActionError::Failed { kind: FailureKind::Output }) }
        });
        let event = match &answered {
            Ok(_) => Some(Event::Worked),
            Err(e) => event_of(e),
        };
        (answered.map(|output| finish(&capability.id, action, output, &values, call.caller.is_model())), event)
    }

    /// An agent calls only what its grant lists; a surface only reads.
    async fn granted(&self, capability: &str, action: &Action, caller: &ActionCaller) -> Result<(), ActionError> {
        match caller {
            ActionCaller::Agent { worker_id } => match self.ports.grants.grant(worker_id).await {
                Some(grant) if !allows(&grant, capability, action) => Err(ActionError::NotGranted),
                _ => Ok(()),
            },
            ActionCaller::Surface { .. } if action.class != ActionClass::Read => Err(ActionError::NotGranted),
            _ => Ok(()),
        }
    }

    async fn execute(
        &self,
        loaded: &Loaded,
        action: &Action,
        call: &ActionCall,
        secrets: HashMap<String, Zeroizing<String>>,
    ) -> Result<Value, ActionError> {
        let capability = &loaded.capability;
        match (&capability.version, self.builtins.get(&capability.id)) {
            (Some(version), _) => self.run_package(loaded, version, action, call.input.clone(), secrets).await,
            (None, Some(builtin)) => {
                let mut secrets = secrets;
                if let ActionCaller::Push { secret } = &call.caller {
                    secrets.insert(WEBHOOK_SECRET.to_owned(), secret.0.clone());
                }
                let ctx = ActionContext {
                    secrets,
                    settings: capability.settings.clone(),
                    idempotency_key: call.idempotency_key.clone(),
                };
                builtin.call(&action.name, call.input.clone(), &ctx).await
            }
            (None, None) => Err(ActionError::NotFound),
        }
    }

    /// Runs a package's action through the runner, once its files still
    /// hash to the pinned hash; each secret goes to the variable its
    /// manifest names.
    pub(crate) async fn run_package(
        &self,
        loaded: &Loaded,
        version: &str,
        action: &Action,
        input: Value,
        mut secrets: HashMap<String, Zeroizing<String>>,
    ) -> Result<Value, ActionError> {
        let Some(runner) = &self.ports.runner else {
            return Err(ActionError::NotReady(StateCode::SandboxUnavailable.as_string()));
        };
        let capability = &loaded.capability;
        self.verify_package(&capability.id, version, loaded.hash.as_deref().unwrap_or_default()).await?;
        let env = capability
            .manifest
            .secrets
            .iter()
            .filter_map(|secret| Some((secret.env.clone()?, secrets.remove(&secret.name)?)))
            .collect();
        let package =
            Package { id: capability.id.clone(), version: version.to_owned(), manifest: capability.manifest.clone() };
        runner.run(&package, &action.name, input, env, Duration::from_secs(u64::from(action.timeout_s))).await
    }

    /// Step 9: one `capability_calls` row and the health the run left, in
    /// one write. A row that cannot be written costs the call nothing.
    async fn record(
        &self,
        loaded: &Loaded,
        action: &Action,
        call: &ActionCall,
        call_id: &str,
        started: i64,
        (answered, event): &(Result<Value, ActionError>, Option<Event>),
    ) {
        let capability = &loaded.capability;
        let now = self.ports.clock.now_ms();
        let (worker_id, run_id) = match &call.caller {
            ActionCaller::Agent { worker_id } => (Some(worker_id.clone()), None),
            // A channel's reads and sends name their delivery, not always its run.
            ActionCaller::Delivery { run_id, .. } => (None, Some(run_id.clone()).filter(|id| !id.is_empty())),
            _ => (None, None),
        };
        let row = StoredCall {
            id: call_id.to_owned(),
            capability_id: capability.id.clone(),
            action: action.name.clone(),
            class: action.class,
            caller_kind: call.caller.kind().to_owned(),
            worker_id,
            run_id,
            version: capability.version.clone(),
            started_at: started,
            duration_ms: now - started,
            outcome: answered.as_ref().map_or_else(ActionError::outcome, |_| "ok").to_owned(),
            error_kind: answered.as_ref().err().map(|e| e.kind().to_owned()),
        };
        tracing::info!(
            capability = %row.capability_id,
            action = %row.action,
            class = ?row.class,
            caller = row.caller_kind,
            outcome = row.outcome,
            error_kind = row.error_kind,
            duration_ms = row.duration_ms,
            "capability call"
        );
        let (id, kept) = (capability.id.clone(), event.clone());
        let written = self
            .ports
            .store
            .write(move |tx, outbox| {
                tx.capability_calls().insert(&row)?;
                if let Some(event) = kept {
                    apply(tx, outbox, &id, event, now)?;
                }
                Ok(())
            })
            .await;
        if let Err(e) = written {
            tracing::warn!(capability = %capability.id, error = %e, "a capability call was not recorded");
        }
        // After the write: a check that ran before it would be overwritten by the failure it checks.
        self.early.after(&capability.id, event.as_ref());
    }
}
