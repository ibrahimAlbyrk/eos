//! `--wait`: the run read every second until it ends, its moves on standard error and its
//! result on standard output. A run that waits for the user says where once, and the wait
//! goes on. The command going away (Ctrl-C) ends the wait; the run goes on.

use std::time::Duration;

use eos_contracts::cli::exit;
use serde_json::Value;

use super::commands::Ctx;

const POLL: Duration = Duration::from_secs(1);
const FINAL: [&str; 4] = ["done", "skipped", "cancelled", "failed"];

/// Waits for one run (its id already escaped for a path); the code its ending maps to.
pub(super) async fn wait_for(ctx: &Ctx, run: &str) -> i32 {
    let mut seen = String::new();
    let mut told_waiting = false;
    loop {
        let answer = ctx.call("GET", &format!("/api/runs/{run}"), None).await;
        if answer.0 != 200 {
            return ctx.refused(&answer);
        }
        let summary = &answer.1["run"];
        let state = summary["state"].as_str().unwrap_or_default();
        let line = match summary["station"].as_str() {
            Some(station) => format!("{state} · {station}"),
            None => state.to_owned(),
        };
        if line != seen && !ctx.err(&line) {
            return exit::DETACHED;
        }
        seen = line;
        if FINAL.contains(&state) {
            return ended(ctx, run, state, summary).await;
        }
        if summary["needsUser"] == true && !told_waiting {
            told_waiting = true;
            let link = inbox_link(ctx, run).await.unwrap_or_else(|| ctx.link("runs", run));
            ctx.err(format!("It waits for you: {link}"));
        } else if summary["needsUser"] != true {
            told_waiting = false;
        }
        tokio::time::sleep(POLL).await;
        if ctx.out.is_closed() {
            return exit::DETACHED;
        }
    }
}

/// The Needs-you item the run waits on.
async fn inbox_link(ctx: &Ctx, run: &str) -> Option<String> {
    let (status, list) = ctx.call("GET", "/api/inbox", None).await;
    if status != 200 {
        return None;
    }
    let id = list["items"].as_array()?.iter().find(|i| i["runId"] == run)?["id"].as_str()?.to_owned();
    Some(ctx.link("inbox", &id))
}

async fn ended(ctx: &Ctx, run: &str, state: &str, summary: &Value) -> i32 {
    if state != "done" {
        if let Some(reason) = summary["reason"].as_str() {
            ctx.err(reason);
        }
        return exit::RUN_FAILED;
    }
    let (status, result) = ctx.call("GET", &format!("/api/runs/{run}/result"), None).await;
    if status == 200 {
        if let Some(headline) = result["headline"].as_str() {
            ctx.out(headline);
        }
        if let Some(text) = result["body"]["text"].as_str().or(result["body"]["markdown"].as_str()) {
            ctx.out(text);
        }
    }
    exit::OK
}
