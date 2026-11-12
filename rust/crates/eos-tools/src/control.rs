//! An orchestrator's hold on its workers, and a worker's line back
//! (`spawn_worker`, `list_active_workers`, `get_worker`, `kill_worker`,
//! `message_worker`, `list_pending_permissions`, `get_worker_messages`,
//! `integrate_workers`, `list_available_workers`, `create_worker`,
//! `send_message_to_parent`).

use std::sync::Arc;

use eos_contracts::{CreateWorkerResponse, SpawnWorkerRequest, WorkerContext, WorkerDefinition, WorkerRow};
use eos_core::agent::{ModelCatalog, WorkerControl};
use eos_core::store::{EventOrder, EventQuery, Store};
use eos_core::{BoxFuture, Error};
use eos_domain::context::context_pct;
use eos_domain::display::sanitize_event;
use eos_domain::worker::{Ownership, ownership};
use eos_domain::{Worker, WorkerLoop};
use eos_workers::WorkerDefinitions;
use eos_workers::catalog::entries;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::messages::newest_messages;
use crate::schema::{Schema, array, boolean, int, object, one_of, string};
use crate::tool::{Call, Failure, Handler, Outcome, Output, Spec, args};

/// The reasoning efforts a worker can be given (`EFFORT_LEVELS`).
const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// What the control tools reach.
#[derive(Clone)]
pub(crate) struct Control {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) models: Arc<dyn ModelCatalog>,
    pub(crate) workers: Arc<dyn WorkerControl>,
    pub(crate) definitions: Arc<WorkerDefinitions>,
}

fn worker_id() -> Schema {
    string().describe("Worker id, e.g. 'w-abcd1234'")
}

/// A row with the parts it does not store: its active goal loop and how full
/// its context window is. What the worker routes hand an agent.
fn enriched(worker: &Worker, active: &[WorkerLoop], models: &dyn ModelCatalog) -> WorkerRow {
    let mut row = worker.to_row();
    row.r#loop = active.iter().find(|l| l.worker_id == row.id).map(WorkerLoop::to_row);
    let limit = models.context_window_for(row.model.as_ref().and_then(|m| m.as_deref()));
    #[allow(clippy::cast_possible_truncation)]
    let used = row.last_context_tokens.flatten().map_or(0, |n| n.0 as i64);
    row.context = Some(WorkerContext {
        used: used.into(),
        limit: Some(limit.into()),
        pct: context_pct(used, Some(limit)).map(Into::into),
    });
    row
}

/// A field as JavaScript reads it off a row: absent stays absent.
fn field(row: &Value, key: &str) -> Option<Value> {
    row.get(key).cloned()
}

/// `row[key] ?? null`.
fn or_null(row: &Value, key: &str) -> Value {
    field(row, key).unwrap_or(Value::Null)
}

/// The first `max` UTF-16 units of `text`, as `slice(0, max)` cuts it; a
/// character that straddles the cut is left out.
fn clip(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

fn put(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

// ---- spawn_worker -----------------------------------------------------------

struct SpawnWorker(Control);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnArgs {
    prompt: String,
    name: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    workspace_of: Option<String>,
    collaborate: Option<bool>,
    from: Option<String>,
    tools_allow: Option<Vec<String>>,
    tools_deny: Option<Vec<String>>,
    edit_regex: Option<String>,
}

/// JavaScript truthiness of an optional string.
fn given(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}

impl Handler for SpawnWorker {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let a: SpawnArgs = args(input)?;
            let mut data = Map::new();
            data.insert("prompt".into(), a.prompt.into());
            put(&mut data, "name", a.name.map(Value::from));
            put(&mut data, "model", a.model.map(Value::from));
            data.insert("withGateway".into(), true.into());
            data.insert("parentId".into(), call.self_id.into());
            put(&mut data, "effort", given(a.effort).map(Value::from));
            if a.collaborate == Some(true) {
                data.insert("collaborate".into(), true.into());
            }
            put(&mut data, "from", given(a.from).map(Value::from));
            put(&mut data, "toolsAllow", a.tools_allow.map(Value::from));
            put(&mut data, "toolsDeny", a.tools_deny.map(Value::from));
            put(&mut data, "editRegex", given(a.edit_regex).map(Value::from));
            // In another worker's worktree when asked; else its own worktree
            // of the orchestrator's repository, or the folder as it is.
            match given(a.workspace_of) {
                Some(target) => {
                    data.insert("workspaceOf".into(), target.into());
                }
                None => {
                    let folder = self.0.workers.folder(call.self_id).await;
                    data.insert(if folder.git_repo { "worktreeFrom" } else { "cwd" }.into(), folder.cwd.into());
                }
            }
            let request: SpawnWorkerRequest = eos_contracts::parse(&Value::Object(data))
                .map_err(|e| Failure::refused(eos_contracts::ValidationError::STATUS, &e.message()))?;
            let spawned = self.0.workers.spawn(request).await?;
            Ok(Output::json(&json!({"id": spawned.id, "isolation": spawned.isolation})))
        })
    }
}

fn spawn_worker_input() -> Schema {
    object(vec![
        (
            "prompt",
            string().describe(
                "The worker's first user-turn (string). Follow the worker-prompt template in your system prompt (§Worker prompts: directive · Context · Acceptance · Out of scope · Report).",
            ),
        ),
        (
            "name",
            string().optional().describe(
                "Friendly slug for the worker (kebab-case). Should describe the outcome, not the action. Good: 'refactor-auth-tokens', 'add-billing-tests'. Bad: 'worker-1', 'fix-stuff', 'task'.",
            ),
        ),
        (
            "model",
            string().optional().describe(
                "Model power tier — one of the tiers the active provider defines (listed strongest-first in your §Model table), mapped to that provider's own models. Also accepts a concrete model id or 'provider/model' sugar (e.g. 'deepseek/deepseek-v4-pro' — sugar for backendProfile=<provider> + model=<rest>, the prefix split off before the API). A tier the provider does not define is rejected. A bare cross-provider model MUST use the combined form, or it will be rejected. Omit ⇒ the provider's default tier.",
            ),
        ),
        (
            "effort",
            one_of(EFFORT_LEVELS).optional().describe(
                "Reasoning effort. Honored only when the active provider exposes an effort lever; ignored otherwise. Which level fits which work → §Model. Omit ⇒ default.",
            ),
        ),
        (
            "workspaceOf",
            string().optional().describe(
                "Spawn this worker INSIDE an existing worker's isolated worktree instead of a fresh one, for direct file access (to review, continue, or fix that worker's work). Pass the id of a worker you spawned (attaching to another orchestrator's worker is rejected). Only allowed while that worker is idle (fails with a conflict while it is busy).",
            ),
        ),
        (
            "collaborate",
            boolean().optional().describe(
                "Give this worker the peer tools (list_peers / ask_peer / respond_to_peer) so it can consult — and be consulted by — the other collaborate workers you spawn under you (its siblings). Omit ⇒ off.",
            ),
        ),
        (
            "from",
            string().optional().describe(
                "Available worker (definition) to spawn from. It pre-fills this worker's defaults (model, effort, permission mode, persistence) and frames its instructions — fields you pass explicitly still win. Omit ⇒ defaults to the general-purpose worker.",
            ),
        ),
        (
            "toolsAllow",
            array(string()).optional().describe(
                "Fence THIS worker's tools for a one-off (globs, e.g. 'Read', 'mcp__*'). Allowlist is exhaustive: anything not listed is denied. Empty/omit ⇒ inherit all tools. Wins over a `from` definition's allowlist.",
            ),
        ),
        (
            "toolsDeny",
            array(string()).optional().describe(
                "Subtract tools from THIS one-off worker (globs). Always subtracts, even from an allowlist. Wins over a `from` definition's denylist.",
            ),
        ),
        (
            "editRegex",
            string().optional().describe(
                "Confine THIS one-off worker's file edits to paths matching this regex (e.g. '(^|/)src/.*\\\\.ts$'). Claude Code passes ABSOLUTE file paths, so anchor with `(^|/)path`, not `^path` (a `^`-anchored relative pattern never matches). Enforced at the gate. Wins over a `from` definition's editRegex.",
            ),
        ),
    ])
}

// ---- list_active_workers ------------------------------------------------------

/// How many workers the list shows, and how much of each prompt.
const LISTED_WORKERS: usize = 30;
const LISTED_PROMPT_UNITS: usize = 100;

struct ListActiveWorkers(Control);

impl Handler for ListActiveWorkers {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let parent = call.self_id.to_owned();
            let (workers, loops) = self
                .0
                .store
                .read(move |tx| {
                    // Archived workers are invisible to agents.
                    let mut workers = tx.workers().list_by_parent(&parent)?;
                    workers.retain(|w| !w.is_archived());
                    Ok((workers, tx.loops().list_active()?))
                })
                .await?;
            let rows: Vec<Value> = workers
                .iter()
                .take(LISTED_WORKERS)
                .map(|worker| {
                    let row =
                        serde_json::to_value(enriched(worker, &loops, self.0.models.as_ref())).unwrap_or_default();
                    let mut out = Map::new();
                    put(&mut out, "id", field(&row, "id"));
                    out.insert("name".into(), or_null(&row, "name"));
                    put(&mut out, "state", field(&row, "state"));
                    out.insert("branch".into(), or_null(&row, "branch"));
                    out.insert("worker_definition".into(), or_null(&row, "worker_definition"));
                    out.insert("context_pct".into(), row["context"]["pct"].clone());
                    put(&mut out, "started_at", field(&row, "started_at"));
                    put(&mut out, "ended_at", field(&row, "ended_at"));
                    out.insert("prompt".into(), clip(&worker.prompt, LISTED_PROMPT_UNITS).into());
                    Value::Object(out)
                })
                .collect();
            Ok(Output::Json(Value::Array(rows)))
        })
    }
}

// ---- get_worker ---------------------------------------------------------------

struct GetWorker(Control);

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

impl Handler for GetWorker {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let IdArgs { id } = args(input)?;
            let target = id.clone();
            let (worker, loops) =
                self.0.store.read(move |tx| Ok((tx.workers().find(&target)?, tx.loops().list_active()?))).await?;
            match ownership(worker.as_ref(), &id, call.self_id, true) {
                Ownership::Owned => {}
                Ownership::Missing => return Err(Error::not_found("worker", id).into()),
                Ownership::NotManaged => {
                    return Err(Failure::refused(403, &format!("worker {id} is not managed by {}", call.self_id)));
                }
            }
            // An archived worker reads as gone.
            let Some(worker) = worker.filter(|w| !w.is_archived()) else {
                return Err(Failure::refused(404, "not found"));
            };
            let row = serde_json::to_value(enriched(&worker, &loops, self.0.models.as_ref())).unwrap_or_default();
            let mut out = Map::new();
            put(&mut out, "id", field(&row, "id"));
            out.insert("name".into(), or_null(&row, "name"));
            put(&mut out, "state", field(&row, "state"));
            out.insert("branch".into(), or_null(&row, "branch"));
            put(&mut out, "prompt", field(&row, "prompt"));
            put(&mut out, "started_at", field(&row, "started_at"));
            for key in [
                "ended_at",
                "exit_code",
                "model",
                "context",
                "loop",
                "worker_definition",
                "cost_usd",
                "parent_id",
                "tasks",
            ] {
                out.insert(key.to_owned(), or_null(&row, key));
            }
            Ok(Output::json(&json!({ "worker": out })))
        })
    }
}

// ---- kill_worker --------------------------------------------------------------

struct KillWorker(Control);

impl Handler for KillWorker {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let IdArgs { id } = args(input)?;
            let gone = self.0.workers.kill(call.self_id, &id).await?;
            Ok(Output::json(&json!({
                "id": gone.id,
                "name": gone.name,
                "removed": gone.removed,
                "was_state": gone.was_state,
            })))
        })
    }
}

// ---- message_worker -----------------------------------------------------------

struct MessageWorker(Control);

#[derive(Deserialize)]
struct MessageArgs {
    id: String,
    text: String,
}

impl Handler for MessageWorker {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let MessageArgs { id, text } = args(input)?;
            if text.is_empty() {
                return Err(Failure::refused(
                    400,
                    "invalid request: text: String must contain at least 1 character(s)",
                ));
            }
            let sent = self.0.workers.message(call.self_id, &id, text).await?;
            Ok(Output::json(&json!({"ok": true, "id": sent.id, "name": sent.name})))
        })
    }
}

// ---- list_pending_permissions -------------------------------------------------

struct ListPendingPermissions(Control);

impl Handler for ListPendingPermissions {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let parent = call.self_id.to_owned();
            let rows = self
                .0
                .store
                .read(move |tx| {
                    let children = tx.workers().find_children_ids(&parent)?;
                    let mut rows = tx.pending().list_unresolved()?;
                    rows.retain(|row| children.contains(&row.worker_id));
                    Ok(rows)
                })
                .await?;
            let rows: Vec<Value> = rows
                .iter()
                .map(|ask| {
                    let row = serde_json::to_value(ask.to_list_row()).unwrap_or_default();
                    let mut out = Map::new();
                    for key in ["id", "worker_id", "tool_name", "input", "expires_at"] {
                        put(&mut out, key, field(&row, key));
                    }
                    Value::Object(out)
                })
                .collect();
            Ok(Output::Json(Value::Array(rows)))
        })
    }
}

// ---- get_worker_messages ------------------------------------------------------

struct GetWorkerMessages(Control);

#[derive(Deserialize)]
struct MessagesArgs {
    id: String,
    n: usize,
}

impl Handler for GetWorkerMessages {
    fn run<'a>(&'a self, _call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let MessagesArgs { id, n } = args(input)?;
            // The log is dense with rows that are no message: read a generous
            // window and keep the newest `n` messages of it.
            let limit = i64::try_from((n * 8).min(200)).unwrap_or(200);
            let query =
                EventQuery { worker_id: id, since: 0, limit, order: EventOrder::Desc, before_id: None, after_id: None };
            let rows = self.0.store.read(move |tx| tx.events().list(&query)).await?;
            let rows: Vec<_> = rows.into_iter().map(sanitize_event).collect();
            Ok(Output::json(&json!({ "messages": newest_messages(&rows, n) })))
        })
    }
}

// ---- integrate_workers --------------------------------------------------------

struct IntegrateWorkers(Control);

#[derive(Deserialize)]
struct IntegrateArgs {
    ids: Option<Vec<String>>,
}

impl Handler for IntegrateWorkers {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let IntegrateArgs { ids } = args(input)?;
            let res = self.0.workers.integrate(call.self_id, ids).await?;
            Ok(Output::json(&json!({
                "ok": res.ok,
                "branch": res.branch,
                "workers": res.workers,
                "message": res.message,
            })))
        })
    }
}

// ---- list_available_workers, create_worker ------------------------------------

struct ListAvailableWorkers(Control);

impl Handler for ListAvailableWorkers {
    fn run<'a>(&'a self, call: Call<'a>, _input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            // Read anew: definitions created after the session started are in it.
            let available = self.0.definitions.available(Some(call.self_id)).await?;
            Ok(Output::json(&entries(&available)))
        })
    }
}

struct CreateWorker(Control);

impl Handler for CreateWorker {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let definition: WorkerDefinition = eos_contracts::parse(&input)
                .map_err(|e| Failure::refused(eos_contracts::ValidationError::STATUS, &e.message()))?;
            // Stored for this orchestrator only; nothing starts until it spawns from it.
            self.0.definitions.create(call.self_id, &definition).await?;
            Ok(Output::json(&CreateWorkerResponse { name: definition.name }))
        })
    }
}

fn create_worker_input() -> Schema {
    object(vec![
        ("name", string().describe("Identity, kebab-case (e.g. 'perf-profiler').")),
        ("description", string().optional().describe("Human-facing label for this worker.")),
        (
            "whenToUse",
            string().optional().describe("Routing signal: when should a task be dispatched to this worker."),
        ),
        (
            "model",
            string().optional().describe(
                "Default model power tier — one of the tiers the active provider defines (listed in your §Model table), mapped to that provider's own models. Also accepts a concrete model id or 'provider/model' sugar. Omit ⇒ inherit.",
            ),
        ),
        (
            "effort",
            one_of(EFFORT_LEVELS).optional().describe(
                "Default reasoning effort. Honored only when the active provider exposes an effort lever; ignored otherwise. Omit ⇒ inherit.",
            ),
        ),
        (
            "permissionMode",
            one_of(&["acceptEdits", "bypassPermissions"]).optional().describe("Default permission mode."),
        ),
        ("persistent", boolean().optional().describe("Stay alive after a turn (conversational session).")),
        ("collaborate", boolean().optional().describe("Default the peer-mesh opt-in.")),
        (
            "toolsAllow",
            array(string())
                .optional()
                .describe("Tool allowlist (globs, e.g. 'Read', 'mcp__*'). Empty/omit ⇒ inherit all tools."),
        ),
        (
            "toolsDeny",
            array(string())
                .optional()
                .describe("Tool denylist (globs). Always subtracts, even from an allowlist."),
        ),
        (
            "editRegex",
            string().optional().describe(
                "Restrict file edits to paths matching this regex (e.g. '(^|/)src/.*\\\\.ts$'). Claude Code passes ABSOLUTE file paths, so anchor with `(^|/)path`, not `^path` (a `^`-anchored relative pattern never matches).",
            ),
        ),
        ("extends", string().optional().describe("Base worker name to inherit unset fields from.")),
        (
            "body",
            string().describe(
                "This worker's role-instructions body (string). What to put in it / what NOT to (never restate the signal protocol / report / Handover) → create_worker's description and §Available workers.",
            ),
        ),
    ])
}

// ---- send_message_to_parent ---------------------------------------------------

struct SendMessageToParent(Control);

#[derive(Deserialize)]
struct ReportArgs {
    text: String,
}

impl Handler for SendMessageToParent {
    fn run<'a>(&'a self, call: Call<'a>, input: Value) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let ReportArgs { text } = args(input)?;
            if text.is_empty() {
                return Err(Failure::refused(
                    400,
                    "invalid request: text: String must contain at least 1 character(s)",
                ));
            }
            self.0.workers.report(call.self_id, text).await?;
            Ok(Output::text("Message delivered to orchestrator."))
        })
    }
}

// ---- the registry's entries ---------------------------------------------------

pub(crate) fn spawn_worker(c: &Control) -> Spec {
    Spec::new("spawn_worker", spawn_worker_input(), SpawnWorker(c.clone()))
}

pub(crate) fn list_active_workers(c: &Control) -> Spec {
    Spec::new("list_active_workers", object(vec![]), ListActiveWorkers(c.clone()))
}

pub(crate) fn get_worker(c: &Control) -> Spec {
    Spec::new("get_worker", object(vec![("id", worker_id())]), GetWorker(c.clone()))
}

pub(crate) fn kill_worker(c: &Control) -> Spec {
    Spec::new("kill_worker", object(vec![("id", worker_id())]), KillWorker(c.clone()))
}

pub(crate) fn message_worker(c: &Control) -> Spec {
    Spec::new(
        "message_worker",
        object(vec![
            ("id", worker_id()),
            (
                "text",
                string().describe(
                    "The follow-up directive — becomes a new user-turn for the worker. State the new ask clearly and in full.",
                ),
            ),
        ]),
        MessageWorker(c.clone()),
    )
}

pub(crate) fn list_pending_permissions(c: &Control) -> Spec {
    Spec::new("list_pending_permissions", object(vec![]), ListPendingPermissions(c.clone()))
}

pub(crate) fn list_available_workers(c: &Control) -> Spec {
    Spec::new("list_available_workers", object(vec![]), ListAvailableWorkers(c.clone()))
}

pub(crate) fn create_worker(c: &Control) -> Spec {
    Spec::new("create_worker", create_worker_input(), CreateWorker(c.clone()))
}

pub(crate) fn integrate_workers(c: &Control) -> Spec {
    Spec::new(
        "integrate_workers",
        object(vec![(
            "ids",
            array(string())
                .optional()
                .describe("Limit to these worker ids. Omit to integrate ALL of your workers' branches."),
        )]),
        IntegrateWorkers(c.clone()),
    )
}

pub(crate) fn get_worker_messages(c: &Control) -> Spec {
    Spec::new(
        "get_worker_messages",
        object(vec![
            ("id", worker_id()),
            (
                "n",
                int().min(1).max(50).default(json!(5)).describe(
                    "How many of the worker's most recent messages to return (5 = last five, 1 = just the latest).",
                ),
            ),
        ]),
        GetWorkerMessages(c.clone()),
    )
}

pub(crate) fn send_message_to_parent(c: &Control) -> Spec {
    Spec::new(
        "send_message_to_parent",
        object(vec![(
            "text",
            string().describe(
                "The report text. First line MUST be `result: ...`, `needs input: ...`, or `failed: ...` (this line is parsed). See the send_message_to_parent guidance for the structure of the lines that follow.",
            ),
        )]),
        SendMessageToParent(c.clone()),
    )
}
