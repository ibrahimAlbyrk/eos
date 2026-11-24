//! Each terminal command as the dashboard's own core calls (07 §4.4): the same routes, the
//! same token, the same dev guard. What a call answers becomes [`CliFrame`] lines.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use eos_contracts::cli::CliFrame;
use eos_contracts::cli::{CliOnce, CliRequest, CliRun, exit};
use eos_contracts::{EstimateRequest, IntentAttachment, ItemRef, OnceRequest, ResultMode, RunInput, StartRunRequest};
use eos_domain::routine::item;
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use super::wait::wait_for;
use crate::ask::ask;
use crate::core::{Core, Plane};
use crate::urlspace::percent_encode;

/// What a command needs: the core, how links are written, and where its lines go.
pub(super) struct Ctx {
    pub core: Arc<dyn Core>,
    /// `eos` or `eos-dev` (`launch::link_scheme`).
    pub scheme: &'static str,
    pub version: String,
    pub out: UnboundedSender<CliFrame>,
}

/// One answer of the core: its status and body.
pub(super) type Answer = (u16, Value);

impl Ctx {
    pub(super) fn send(&self, frame: CliFrame) -> bool {
        self.out.send(frame).is_ok()
    }

    pub(super) fn out(&self, text: impl Into<String>) -> bool {
        self.send(CliFrame::Out { text: text.into() })
    }

    pub(super) fn err(&self, text: impl Into<String>) -> bool {
        self.send(CliFrame::Err { text: text.into() })
    }

    pub(super) async fn call(&self, method: &str, target: &str, body: Option<Value>) -> Answer {
        let token = self.core.ui_token();
        ask(&*self.core, Plane::Api, method, target, &token, body.as_ref())
            .await
            .unwrap_or((503, json!({ "error": "Eos did not answer" })))
    }

    /// A refusal as one line, and the code the command ends with.
    pub(super) fn refused(&self, (status, body): &Answer) -> i32 {
        let text = body["error"].as_str().map_or_else(|| format!("Eos answered {status}"), str::to_owned);
        self.err(text);
        exit::REFUSED
    }

    pub(super) fn link(&self, what: &str, id: &str) -> String {
        format!("{}://{what}/{id}", self.scheme)
    }
}

/// Runs one request to the end; the exit code the command ends with.
pub(super) async fn handle(ctx: &Ctx, request: CliRequest) -> i32 {
    match request {
        CliRequest::Hello => {
            ctx.send(CliFrame::Hello { version: ctx.version.clone(), ready: true });
            exit::OK
        }
        CliRequest::Routines { json } => routines(ctx, json).await,
        CliRequest::Run(run) => start(ctx, run).await,
        CliRequest::Once(once) => start_once(ctx, once).await,
        CliRequest::Halt => switch(ctx, "/api/eos/halt", "Routines stopped. `eos resume` starts them again.").await,
        CliRequest::Resume => switch(ctx, "/api/eos/resume", "Routines resumed.").await,
        CliRequest::MemoryHook { event, input } => memory_hook(ctx, event, input).await,
    }
}

async fn routines(ctx: &Ctx, as_json: bool) -> i32 {
    let answer = ctx.call("GET", "/api/routines", None).await;
    if answer.0 != 200 {
        return ctx.refused(&answer);
    }
    let rows = answer.1.as_array().cloned().unwrap_or_default();
    if as_json {
        ctx.send(CliFrame::Json { value: Value::Array(rows) });
        return exit::OK;
    }
    if rows.is_empty() {
        ctx.err("No routines yet.");
    }
    for row in rows.iter().filter(|r| matches!(r["state"].as_str(), Some("active" | "paused"))) {
        let paused = if row["state"] == "paused" { " (paused)" } else { "" };
        ctx.out(format!(
            "{:<24} {}{paused} · {}",
            row["slug"].as_str().unwrap_or_default(),
            row["name"].as_str().unwrap_or_default(),
            row["summary"].as_str().unwrap_or_default()
        ));
    }
    exit::OK
}

/// The routine a slug or an id names, among those that take hand runs.
async fn routine(ctx: &Ctx, name: &str) -> Result<Value, i32> {
    let answer = ctx.call("GET", "/api/routines", None).await;
    if answer.0 != 200 {
        return Err(ctx.refused(&answer));
    }
    let found = answer.1.as_array().and_then(|rows| {
        rows.iter()
            .find(|r| {
                (r["slug"] == name || r["id"] == name) && matches!(r["state"].as_str(), Some("active" | "paused"))
            })
            .cloned()
    });
    found.ok_or_else(|| {
        ctx.err(format!("No routine named {name}. `eos routines` lists them."));
        exit::REFUSED
    })
}

fn items_of(run: &CliRun) -> Vec<ItemRef> {
    let typed = run.items.iter().map(|text| item::typed(text));
    let files = run
        .files
        .iter()
        .map(|path| item::outside(if std::path::Path::new(path).is_dir() { "folder" } else { "file" }, path));
    typed.chain(files).chain(run.stdin.iter().map(|text| item::outside("text", text))).collect()
}

fn result_mode(show_only: bool) -> ResultMode {
    if show_only { ResultMode::ShowOnly } else { ResultMode::Usual }
}

/// The start routes answer 201; any 2xx means the call did what it asked.
fn is_success(status: u16) -> bool {
    (200..300).contains(&status)
}

/// A request id of this app's life: the same request sent again starts nothing twice.
fn request_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("cli-{started}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

async fn start(ctx: &Ctx, run: CliRun) -> i32 {
    let routine = match routine(ctx, &run.routine).await {
        Ok(routine) => routine,
        Err(code) => return code,
    };
    let (id, name) =
        (routine["id"].as_str().unwrap_or_default().to_owned(), routine["name"].as_str().unwrap_or_default());
    let at = match run.at.as_deref().map(eos_domain::time::ms_from_iso) {
        Some(None) => {
            ctx.err("--at takes a time with its zone, like 2026-11-19T09:00+01:00.");
            return exit::REFUSED;
        }
        at => at.flatten(),
    };
    let mut items = items_of(&run);
    let input = RunInput {
        item: (items.len() == 1).then(|| items.remove(0)),
        items: None,
        trigger: None,
        options: run.options.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect(),
        note: run.note.clone(),
        result: result_mode(run.show_only),
        at,
        surface: None,
        chat: None,
    };
    if items.len() > 1 && !run.yes {
        let estimate = EstimateRequest { routine_id: id.clone(), input: input.clone(), count: items.len() as i64 };
        let answer = ctx.call("POST", "/api/runs/estimate", serde_json::to_value(estimate).ok()).await;
        if answer.0 != 200 {
            return ctx.refused(&answer);
        }
        let usd = answer.1["usd"].as_f64().unwrap_or(0.0);
        ctx.send(CliFrame::Confirm { text: format!("Start {} runs of {name}? About ${usd:.2} in all.", items.len()) });
        return exit::REFUSED;
    }
    let item_line = input.item.as_ref().and_then(|i| i.url.clone().or(i.path.clone()).or(i.text.clone()));
    let asked = StartRunRequest {
        routine_id: id.clone(),
        input,
        items: (!items.is_empty()).then_some(items),
        again_of: None,
        door: "terminal".into(),
        confirm_repeat: None,
        client_request_id: Some(request_id()),
    };
    let answer = ctx.call("POST", "/api/runs", serde_json::to_value(asked).ok()).await;
    if !is_success(answer.0) {
        return ctx.refused(&answer);
    }
    tracing::info!(target: "eos::cli", command = "run", routine = %id, runs = answer.1["runs"].as_array().map_or(0, Vec::len), "started");
    let runs: Vec<String> =
        answer.1["runs"].as_array().into_iter().flatten().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect();
    started(ctx, name, item_line.as_deref(), &runs, run.json, &answer.1);
    if run.wait { wait_all(ctx, &runs).await } else { exit::OK }
}

async fn start_once(ctx: &Ctx, once: CliOnce) -> i32 {
    let file = |path: &String| IntentAttachment { kind: "file".into(), value: path.clone() };
    let piped = once.stdin.iter().map(|text| IntentAttachment { kind: "text".into(), value: text.clone() });
    let asked = OnceRequest {
        text: once.what.clone(),
        attachments: once.files.iter().map(file).chain(piped).collect(),
        result: result_mode(once.show_only),
        door: "terminal".into(),
    };
    let answer = ctx.call("POST", "/api/runs/once", serde_json::to_value(asked).ok()).await;
    if !is_success(answer.0) {
        return ctx.refused(&answer);
    }
    let run = answer.1["run"]["id"].as_str().unwrap_or_default().to_owned();
    tracing::info!(target: "eos::cli", command = "once", run = %run, "started");
    started(ctx, answer.1["name"].as_str().unwrap_or("it"), None, std::slice::from_ref(&run), once.json, &answer.1);
    if once.wait { wait_all(ctx, &[run]).await } else { exit::OK }
}

fn started(ctx: &Ctx, name: &str, item: Option<&str>, runs: &[String], as_json: bool, answer: &Value) {
    if as_json {
        ctx.send(CliFrame::Json { value: answer.clone() });
        return;
    }
    match runs {
        [run] => {
            let on = item.map(|i| format!(" on {i}")).unwrap_or_default();
            ctx.out(format!("Started {name}{on}. Open it: {}", ctx.link("runs", run)));
        }
        _ => {
            ctx.out(format!("Started {} runs of {name}.", runs.len()));
            for run in runs {
                ctx.out(format!("  {}", ctx.link("runs", run)));
            }
        }
    }
}

/// Waits for each run in turn; the worst ending decides the code.
async fn wait_all(ctx: &Ctx, runs: &[String]) -> i32 {
    let mut code = exit::OK;
    for run in runs {
        code = code.max(wait_for(ctx, &percent_encode(run)).await);
        if code == exit::DETACHED {
            break;
        }
    }
    code
}

async fn switch(ctx: &Ctx, target: &str, said: &str) -> i32 {
    let answer = ctx.call("POST", target, Some(json!({}))).await;
    if answer.0 != 200 {
        return ctx.refused(&answer);
    }
    ctx.out(said);
    exit::OK
}

/// A Claude Code hook's input to memory (04 G34). Its answer is printed as it is; anything
/// else prints nothing, so the tool goes on as if Eos were not there.
async fn memory_hook(ctx: &Ctx, event: String, input: Value) -> i32 {
    let (status, answer) = ctx.call("POST", "/api/memory/hook", Some(json!({ "event": event, "input": input }))).await;
    if status == 200 && !answer.is_null() {
        ctx.send(CliFrame::Json { value: answer });
    }
    exit::OK
}
