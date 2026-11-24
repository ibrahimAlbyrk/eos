//! What the terminal asks Eos to start is confirmed in Eos's window, never started by the
//! command itself: any program the user runs can run `eos`, a script or an agent steered by
//! text it read among them, and a run, a one-off or the end of a halt must not start without
//! the user's click in Eos. So the command does what a link does: it hands the app an
//! `eos://` link over the shell's own socket (`shell.sock`, as a second launch does), the
//! app shows the filled form or the quick panel, and with `--wait` the command follows the
//! run the user starts there.

use std::time::Duration;

use eos_contracts::cli::CliRun;
use tokio::time::Instant;

use super::commands::Ctx;
use crate::instance::{self, Request};
use crate::links::{Link, MAX_LINK, parse};
use crate::urlspace::percent_encode;

/// The shell's socket in its data folder, beside `cli.sock`.
pub(super) const SHELL_SOCKET: &str = "shell.sock";
/// How long `--wait` waits for the user to press Run.
const CONFIRM_WITHIN: Duration = Duration::from_secs(10 * 60);
const POLL: Duration = Duration::from_secs(1);

/// Hands the app `request` as a later launch would; `false` when no app answers.
pub(super) async fn open_in_app(ctx: &Ctx, request: Request) -> bool {
    let socket = ctx.shell_data.join(SHELL_SOCKET);
    let asked = tokio::task::spawn_blocking(move || {
        let stream = instance::connect(&socket)?;
        instance::ask(stream, &request).ok()
    });
    matches!(asked.await, Ok(Some(_)))
}

/// The `eos://run/<slug>` link that fills the run form with what the command asked: its one
/// item, note, options, show-only and time. `None` when the link could not carry it (too long,
/// or an option named outside the link grammar).
pub(super) fn run_link(scheme: &str, slug: &str, run: &CliRun, item: Option<&str>) -> Option<String> {
    let mut query = Vec::new();
    if let Some(item) = item {
        query.push(format!("item={}", percent_encode(item)));
    }
    if let Some(note) = &run.note {
        query.push(format!("note={}", percent_encode(note)));
    }
    for (name, value) in &run.options {
        query.push(format!("opt.{name}={}", percent_encode(value)));
    }
    if run.show_only {
        query.push("show-only=1".into());
    }
    if let Some(at) = &run.at {
        query.push(format!("at={}", percent_encode(at)));
    }
    let query = if query.is_empty() { String::new() } else { format!("?{}", query.join("&")) };
    let link = format!("{scheme}://run/{slug}{query}");
    // What the app will read: a link outside the grammar would only open the window.
    matches!(parse(&link), Link::Open(_)).then_some(link)
}

/// The `eos://send` link that holds `text` for the quick panel; `None` past a link's length.
pub(super) fn send_link(scheme: &str, text: &str) -> Option<String> {
    let link = format!("{scheme}://send?text={}", percent_encode(text));
    (link.len() <= MAX_LINK && matches!(parse(&link), Link::Send(_))).then_some(link)
}

/// The newest run of `routine_id`, as the runs page lists it.
pub(super) async fn newest(ctx: &Ctx, routine_id: &str) -> Result<Option<String>, i32> {
    let target = format!("/api/runs?routineId={}&limit=1", percent_encode(routine_id));
    let answer = ctx.call("GET", &target, None).await;
    if answer.0 != 200 {
        return Err(ctx.refused(&answer));
    }
    Ok(answer.1["runs"][0]["id"].as_str().map(str::to_owned))
}

/// The run the user started from the form: the first newer than `before`. `None` when
/// nothing was started in time, or the command went away.
pub(super) async fn confirmed(ctx: &Ctx, routine_id: &str, before: Option<String>) -> Option<String> {
    let deadline = Instant::now() + CONFIRM_WITHIN;
    while Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
        if ctx.out.is_closed() {
            return None;
        }
        match newest(ctx, routine_id).await {
            Ok(Some(run)) if Some(&run) != before.as_ref() => return Some(run),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
}
