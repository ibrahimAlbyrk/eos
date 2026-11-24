//! Each terminal command as the dashboard's own core calls (07 §4.4): the same routes, the
//! same token, the same dev guard. What starts something (a run, a one-off, the end of a
//! halt) is asked in Eos's window instead ([`super::confirm`]). What a call answers becomes
//! [`CliFrame`] lines.

use std::path::PathBuf;
use std::sync::Arc;

use eos_contracts::cli::CliFrame;
use eos_contracts::cli::{CliOnce, CliRequest, CliRun, exit};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use super::confirm::{confirmed, newest, open_in_app, run_link, send_link};
use super::wait::wait_for;
use crate::ask::ask;
use crate::core::{Core, Plane};
use crate::instance::Request;
use crate::urlspace::percent_encode;

/// What a command needs: the core, how links are written, and where its lines go.
pub(super) struct Ctx {
    pub core: Arc<dyn Core>,
    /// `eos` or `eos-dev` (`launch::link_scheme`).
    pub scheme: &'static str,
    pub version: String,
    /// The shell's data folder, where the app's own socket is.
    pub shell_data: PathBuf,
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
        CliRequest::Resume => resume(ctx).await,
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

/// The routines stay halted until the user lifts the halt in Eos: the window opens there.
async fn resume(ctx: &Ctx) -> i32 {
    if !open_in_app(ctx, Request::Activate).await {
        ctx.err("Eos did not answer. Open Eos and resume routines there.");
        return exit::UNREACHABLE;
    }
    tracing::info!(target: "eos::cli", command = "resume", "asked in Eos");
    ctx.out("Resume routines in Eos: they stay stopped until you resume them there.");
    exit::OK
}

/// The start route answers 201; any 2xx means the call did what it asked.
fn is_success(status: u16) -> bool {
    (200..300).contains(&status)
}

async fn start(ctx: &Ctx, run: CliRun) -> i32 {
    let routine = match routine(ctx, &run.routine).await {
        Ok(routine) => routine,
        Err(code) => return code,
    };
    let (id, slug, name) = (
        routine["id"].as_str().unwrap_or_default().to_owned(),
        routine["slug"].as_str().unwrap_or_default(),
        routine["name"].as_str().unwrap_or_default(),
    );
    if !run.files.is_empty() {
        ctx.err("Files reach a routine through Eos: drop them on its Dock icon or share them to Eos.");
        return exit::REFUSED;
    }
    let items: Vec<&str> = run.items.iter().map(String::as_str).chain(run.stdin.as_deref()).collect();
    if items.len() > 1 {
        ctx.err("Start one item at a time here, or several from the routine in Eos.");
        return exit::REFUSED;
    }
    if run.at.as_deref().is_some_and(|at| eos_domain::time::ms_from_iso(at).is_none()) {
        ctx.err("--at takes a time with its zone, like 2026-11-19T09:00+01:00.");
        return exit::REFUSED;
    }
    let Some(link) = run_link(ctx.scheme, slug, &run, items.first().copied()) else {
        ctx.err(
            "Eos cannot ask for this run: the item or note is too long, or an option has a name Eos cannot pass on.",
        );
        return exit::REFUSED;
    };
    let before = match newest(ctx, &id).await {
        Ok(before) => before,
        Err(code) => return code,
    };
    if !open_in_app(ctx, Request::Open(link)).await {
        ctx.err("Eos did not answer. Open Eos and try again.");
        return exit::UNREACHABLE;
    }
    tracing::info!(target: "eos::cli", command = "run", routine = %id, "asked in Eos");
    ctx.out(format!("Confirm {name} in Eos: nothing starts until you press Run there."));
    if !run.wait {
        return exit::OK;
    }
    let Some(started) = confirmed(ctx, &id, before).await else {
        ctx.err("Not started: the run was not confirmed in Eos.");
        return exit::REFUSED;
    };
    if run.json {
        ctx.send(CliFrame::Json { value: json!({ "runs": [{ "id": started }] }) });
    } else {
        ctx.out(format!("Started {name}. Open it: {}", ctx.link("runs", &started)));
    }
    wait_for(ctx, &percent_encode(&started)).await
}

/// A one-off is asked in the quick panel: its sentence and piped text are held there, as an
/// `eos://send` link holds text, until the user starts it.
async fn start_once(ctx: &Ctx, once: CliOnce) -> i32 {
    if !once.files.is_empty() {
        ctx.err("Files reach a one-off through Eos: drop them on its Dock icon or share them to Eos.");
        return exit::REFUSED;
    }
    let text = match &once.stdin {
        Some(piped) => format!("{}\n\n{piped}", once.what),
        None => once.what.clone(),
    };
    let Some(link) = send_link(ctx.scheme, &text) else {
        ctx.err("Eos cannot hold this much: paste it in Eos.");
        return exit::REFUSED;
    };
    if !open_in_app(ctx, Request::Open(link)).await {
        ctx.err("Eos did not answer. Open Eos and try again.");
        return exit::UNREACHABLE;
    }
    tracing::info!(target: "eos::cli", command = "once", "asked in Eos");
    ctx.out("Eos holds it in the quick panel: say what to do with it there.");
    if once.wait {
        ctx.err("--wait does not follow a one-off: see it in Eos.");
    }
    exit::OK
}

async fn switch(ctx: &Ctx, target: &str, said: &str) -> i32 {
    let answer = ctx.call("POST", target, Some(json!({}))).await;
    if !is_success(answer.0) {
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
