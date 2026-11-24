//! A press of a surface's button, in the order 05 Q4 sets: a repeated
//! `clientId` answers its first record; then lookup, scope, arguments filled
//! by the core from the stored issue (never taken from the frame), the
//! press limit, the gate (run, confirm here, hold in Needs you, refuse), the
//! handler and the record. "Confirm here" answers a single-use token that
//! lasts two minutes; Eos's own dialog repeats the press with it, and for an
//! action that cannot be taken back, with its name as the user typed it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{ActionAnswer, ActionClass, ActionRunRequest};
use eos_core::inbox::{ActionDecision, ActionGate, ActionRequest};
use eos_core::store::{Store, StoredActionRecord};
use eos_core::surface::DirectActions;
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_runtime::actions::{ActionCall, ActionDecl, ActionScope, Actions};
use eos_surface::limits::{ACTIONS_PER_SECOND, CONFIRM_TOKEN_MS};
use eos_surface::{IssueKind, fill_args, format_problems, validate};
use serde_json::{Value, json};

use crate::records::{self, answer_of, reason};

/// What the dispatcher is built from.
pub(crate) struct DispatchParts {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    /// The registry, filled once the app is built.
    pub(crate) actions: Actions,
    pub(crate) gate: Arc<dyn ActionGate>,
}

impl std::fmt::Debug for DispatchParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchParts").finish_non_exhaustive()
    }
}

pub(crate) struct Dispatcher {
    parts: DispatchParts,
    /// Confirm token → (record id, good until).
    tokens: Mutex<HashMap<String, (String, i64)>>,
}

impl std::fmt::Debug for Dispatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dispatcher").finish_non_exhaustive()
    }
}

/// A press the core could make sense of: the action and its typed arguments.
struct Resolved {
    decl: ActionDecl,
    args: Value,
    surface_id: Option<String>,
    issue_id: Option<String>,
    routine_id: Option<String>,
}

fn refused(reason: impl Into<String>) -> ActionAnswer {
    ActionAnswer::Refused { record_id: None, reason: reason.into() }
}

/// The name the user types to confirm `decl`: only one that cannot be taken back asks for it.
fn type_to_confirm(decl: &ActionDecl) -> Option<String> {
    (decl.class == ActionClass::Irreversible).then(|| decl.title.to_owned())
}

/// Whether the user typed `name`, as a person would: case and spaces around aside.
fn typed_as(typed: Option<&str>, name: &str) -> bool {
    typed.is_some_and(|typed| typed.trim().to_lowercase() == name.trim().to_lowercase())
}

impl Dispatcher {
    pub(crate) fn new(parts: DispatchParts) -> Self {
        Self { parts, tokens: Mutex::default() }
    }

    fn decl(&self, id: &str) -> Option<ActionDecl> {
        self.parts.actions.registry().action(id).cloned()
    }

    /// The action and arguments a press means, or why it means nothing.
    async fn resolve(&self, req: &ActionRunRequest) -> Result<Result<Resolved, String>, Error> {
        let action_id = req.action_id.clone().unwrap_or_default();
        let state = req.state.clone().unwrap_or_else(|| json!({}));
        let Some(issue_id) = req.issue_id.clone() else {
            let Some(decl) = self.decl(&action_id) else { return Ok(Err("That action does not exist".into())) };
            if decl.scope != ActionScope::Any {
                return Ok(Err("That action runs only from its routine's surface".into()));
            }
            return Ok(Ok(Resolved { decl, args: state, surface_id: None, issue_id: None, routine_id: None }));
        };
        if req.button.is_some() {
            return Ok(Err("That issue has no such button".into()));
        }
        let lookup = issue_id.clone();
        let found = self
            .parts
            .store
            .read(move |tx| {
                let Some(issue) = tx.surface_issues().find(&lookup)? else { return Ok(None) };
                Ok(tx.surfaces().find(&issue.surface_id)?.map(|surface| (issue, surface)))
            })
            .await?;
        let Some((issue, surface)) = found else { return Ok(Err("That issue is gone".into())) };
        if issue.kind != IssueKind::View {
            return Ok(Err("That issue has no such button".into()));
        }
        let body: Value = serde_json::from_str(&issue.body_json).unwrap_or_default();
        let Some(binding) = body["bindings"].get(&action_id) else { return Ok(Err("That button runs nothing".into())) };
        let bound = binding["action"].as_str().unwrap_or_default();
        let Some(decl) = self.decl(bound) else { return Ok(Err("That action does not exist".into())) };
        let template = binding["args"].as_object().cloned().unwrap_or_default();
        let args = fill_args(&template, &body["view"]["data"], &state);
        Ok(Ok(Resolved {
            decl,
            args,
            surface_id: Some(surface.id),
            issue_id: Some(issue.id),
            routine_id: Some(surface.routine_id),
        }))
    }

    fn token_for(&self, record_id: &str, now: i64) -> String {
        let token = self.parts.ids.uuid();
        let mut tokens = self.tokens.lock().unwrap_or_else(PoisonError::into_inner);
        tokens.retain(|_, (_, until)| *until > now);
        tokens.insert(token.clone(), (record_id.to_owned(), now + CONFIRM_TOKEN_MS));
        token
    }

    /// Whether `token` confirms `record_id` now; a token is good once.
    fn take_token(&self, token: &str, record_id: &str, now: i64) -> bool {
        let taken = self.tokens.lock().unwrap_or_else(PoisonError::into_inner).remove(token);
        taken.is_some_and(|(id, until)| id == record_id && until > now)
    }

    fn record(
        &self,
        req: &ActionRunRequest,
        r: &Resolved,
        origin: &str,
        decision: &str,
        status: &str,
    ) -> StoredActionRecord {
        StoredActionRecord {
            id: self.parts.ids.action_record_id(),
            client_id: Some(req.client_id.clone()),
            action_id: r.decl.id.to_owned(),
            surface_id: r.surface_id.clone(),
            issue_id: r.issue_id.clone(),
            routine_id: r.routine_id.clone(),
            origin: origin.to_owned(),
            class: r.decl.class,
            args_json: r.args.to_string(),
            decision: decision.to_owned(),
            status: status.to_owned(),
            result_json: None,
            error_kind: None,
            created_at: self.parts.clock.now_ms(),
            finished_at: None,
        }
    }

    fn gate_request(decl: &ActionDecl, routine_id: Option<&str>, args: &Value, origin: &str) -> ActionRequest {
        ActionRequest {
            routine_id: routine_id.unwrap_or_default().to_owned(),
            class: decl.class,
            action_id: decl.id.to_owned(),
            title: decl.title.to_owned(),
            args: args.clone(),
            origin: origin.to_owned(),
        }
    }

    /// Calls the handler with no lock held, then finishes the record.
    async fn execute(&self, decl: &ActionDecl, mut record: StoredActionRecord) -> Result<ActionAnswer, Error> {
        let call = ActionCall {
            action_id: record.action_id.clone(),
            routine_id: record.routine_id.clone(),
            args: serde_json::from_str(&record.args_json).unwrap_or_default(),
            origin: record.origin.clone(),
            record_id: record.id.clone(),
        };
        let outcome = decl.handler.run(call).await;
        record.finished_at = Some(self.parts.clock.now_ms());
        let answer = match outcome {
            Ok(result) => {
                record.status = "done".into();
                record.result_json = Some(result.to_string());
                ActionAnswer::Done { record_id: record.id.clone(), result: Some(result) }
            }
            Err(failure) => {
                record.status = "failed".into();
                record.error_kind = Some(failure.kind.clone());
                record.result_json = reason(&failure.reason);
                ActionAnswer::Refused { record_id: Some(record.id.clone()), reason: failure.reason }
            }
        };
        tracing::info!(record = %record.id, action = %record.action_id, status = %record.status, "a direct action ran");
        records::update(self.parts.store.as_ref(), record).await?;
        Ok(answer)
    }

    async fn finish_refused(&self, mut record: StoredActionRecord, why: &str) -> Result<ActionAnswer, Error> {
        record.status = "refused".into();
        record.result_json = reason(why);
        record.finished_at = Some(self.parts.clock.now_ms());
        let id = record.id.clone();
        records::update(self.parts.store.as_ref(), record).await?;
        Ok(ActionAnswer::Refused { record_id: Some(id), reason: why.to_owned() })
    }

    /// The repeat of a press Eos asked the user to confirm. A name typed
    /// wrong leaves the token good, so the user can type it again.
    async fn confirmed(&self, record: StoredActionRecord, req: &ActionRunRequest) -> Result<ActionAnswer, Error> {
        let now = self.parts.clock.now_ms();
        let prompt = serde_json::from_str::<Value>(record.result_json.as_deref().unwrap_or("{}")).unwrap_or_default();
        let Some(decl) = self.decl(&record.action_id) else {
            return self.finish_refused(record, "That action does not exist").await;
        };
        let Some(token) = req.confirm.as_deref() else {
            let token = self.token_for(&record.id, now);
            let prompt = prompt["prompt"].as_str().unwrap_or_default().to_owned();
            let type_to_confirm = type_to_confirm(&decl);
            return Ok(ActionAnswer::Confirm { record_id: record.id, token, prompt, type_to_confirm });
        };
        if let Some(name) = type_to_confirm(&decl).filter(|name| !typed_as(req.typed.as_deref(), name)) {
            let reason = format!("Type {name} to go ahead");
            return Ok(ActionAnswer::Refused { record_id: Some(record.id), reason });
        }
        if !self.take_token(token, &record.id, now) {
            return self.finish_refused(record, "That confirmation is no longer good").await;
        }
        let args: Value = serde_json::from_str(&record.args_json).unwrap_or_default();
        let request = Self::gate_request(&decl, record.routine_id.as_deref(), &args, &record.origin);
        match self.parts.gate.decide(&request).await? {
            ActionDecision::Run | ActionDecision::Confirm { .. } => self.execute(&decl, record).await,
            ActionDecision::Refuse { reason } => self.finish_refused(record, &reason).await,
            ActionDecision::Hold { .. } => self.finish_refused(record, "That action waits in Needs you").await,
        }
    }

    async fn dispatch(&self, req: ActionRunRequest, origin: &str) -> Result<ActionAnswer, Error> {
        let client = req.client_id.clone();
        if let Some(first) = self.parts.store.read(move |tx| tx.action_log().by_client(&client)).await? {
            if first.status == "confirming" {
                return self.confirmed(first, &req).await;
            }
            return Ok(answer_of(&first));
        }
        let resolved = match self.resolve(&req).await? {
            Ok(resolved) => resolved,
            Err(why) => return Ok(refused(why)),
        };
        let checked = validate(&resolved.decl.args, &resolved.args);
        if !checked.is_ok() {
            return Ok(refused(format!("The arguments do not fit: {}", format_problems(&checked.problems))));
        }
        if let Some(surface) = resolved.surface_id.clone() {
            let since = self.parts.clock.now_ms() - 1_000;
            let recent = self.parts.store.read(move |tx| tx.action_log().count_since(&surface, since)).await?;
            if recent >= i64::from(ACTIONS_PER_SECOND) {
                return Ok(refused("Too many presses at once; try again in a moment"));
            }
        }
        let request = Self::gate_request(&resolved.decl, resolved.routine_id.as_deref(), &resolved.args, origin);
        let decision = self.parts.gate.decide(&request).await?;
        let store = self.parts.store.as_ref();
        match decision {
            ActionDecision::Run => {
                let record = records::insert(store, self.record(&req, &resolved, origin, "run", "running")).await?;
                self.execute(&resolved.decl, record).await
            }
            ActionDecision::Confirm { prompt } => {
                let mut record = self.record(&req, &resolved, origin, "confirm", "confirming");
                record.result_json = Some(json!({ "prompt": prompt }).to_string());
                let record = records::insert(store, record).await?;
                let token = self.token_for(&record.id, self.parts.clock.now_ms());
                let type_to_confirm = type_to_confirm(&resolved.decl);
                Ok(ActionAnswer::Confirm { record_id: record.id, token, prompt, type_to_confirm })
            }
            ActionDecision::Hold { item_id } => {
                let mut record = self.record(&req, &resolved, origin, "hold", "held");
                record.result_json = Some(json!({ "itemId": item_id }).to_string());
                record.finished_at = Some(record.created_at);
                let record = records::insert(store, record).await?;
                tracing::info!(record = %record.id, action = %record.action_id, "a direct action waits in Needs you");
                Ok(ActionAnswer::Held { record_id: record.id, item_id })
            }
            ActionDecision::Refuse { reason: why } => {
                let mut record = self.record(&req, &resolved, origin, "refuse", "refused");
                record.result_json = reason(&why);
                record.finished_at = Some(record.created_at);
                let record = records::insert(store, record).await?;
                Ok(ActionAnswer::Refused { record_id: Some(record.id), reason: why })
            }
        }
    }
}

impl DirectActions for Dispatcher {
    fn run<'a>(&'a self, request: ActionRunRequest, origin: &'a str) -> BoxFuture<'a, Result<ActionAnswer, Error>> {
        Box::pin(self.dispatch(request, origin))
    }
}
