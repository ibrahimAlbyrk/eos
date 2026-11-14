//! One-shot commands the user runs from the composer with `!`.
//!
//! Each run is the command line in the user's shell, in the chat's folder —
//! no terminal, no agent turn, no change to the worker's state. Output goes
//! out as batched `terminal:chunk` events; the end saves one `terminal` row
//! to the chat, so its history carries a single row per command instead of
//! its chunks. A run with no chat (a folder only) saves nothing. Every run is
//! a `shell` job in the Jobs tab, with its output and a stop.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use eos_contracts::WorkerEventType;
use eos_contracts::stream::topics;
use eos_core::store::Store;
use eos_core::terminal::{CommandEvents, CommandExit, RunningCommand, ShellCommands};
use eos_core::{Clock, Ids};
use eos_runtime::bus::{Bus, Topic};
use eos_runtime::jobs::{JobActionError, JobHandle, JobRegistry, JobSpec, JobStatus};
use regress::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStart {
    pub worker_id: Option<String>,
    pub run_id: String,
    pub command: String,
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChunk {
    pub worker_id: Option<String>,
    pub run_id: String,
    pub command: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDone {
    pub worker_id: Option<String>,
    pub run_id: String,
    pub exit_code: i32,
    pub note: Option<String>,
}

pub const TERMINAL_START: Topic<TerminalStart> = Topic::new(topics::TERMINAL_START);
pub const TERMINAL_CHUNK: Topic<TerminalChunk> = Topic::new(topics::TERMINAL_CHUNK);
pub const TERMINAL_DONE: Topic<TerminalDone> = Topic::new(topics::TERMINAL_DONE);

/// The `terminal` row a finished run leaves in its chat.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalRow<'a> {
    run_id: &'a str,
    command: &'a str,
    cwd: &'a str,
    output: &'a str,
    exit_code: i32,
    signal: Option<&'a str>,
    note: Option<&'a str>,
    truncated: bool,
    duration_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerChange<'a> {
    worker_id: &'a str,
}

const FLUSH_WINDOW: Duration = Duration::from_millis(200);
/// Sizes are counted as JavaScript counts a string (UTF-16 units), so the
/// limits cut where today's do.
const FLUSH_UNITS: usize = 8 * 1024;
const MAX_SAVED_UNITS: usize = 256 * 1024;
const MAX_STREAMED_UNITS: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10 * 60);

const STOPPED: &str = "stopped by user";
const TIMED_OUT: &str = "timed out after 10m";
const TOO_MUCH: &str = "output limit exceeded (2MB)";

/// CSI and OSC sequences. A sequence cut between two pieces of output is not
/// recognized — rare without a terminal (most tools turn colour off).
static ANSI: LazyLock<Regex> =
    LazyLock::new(|| match Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?") {
        Ok(regex) => regex,
        Err(e) => panic!("the pattern is fixed and valid: {e}"),
    });

pub(crate) fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for m in ANSI.find_iter(text) {
        out.push_str(&text[at..m.start()]);
        at = m.end();
    }
    out.push_str(&text[at..]);
    out
}

fn units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The first `max` UTF-16 units of `text`, never half a character.
fn first_units(text: &str, max: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        used += c.len_utf16();
        if used > max {
            return &text[..at];
        }
    }
    text
}

/// A job's one line of "what is happening": the text's first non-empty line,
/// cut at 160.
fn first_line(text: &str) -> Option<String> {
    const MAX: usize = 160;
    let line = text.split('\n').map(eos_domain::text::js_trim).find(|l| !l.is_empty())?;
    Some(if units(line) > MAX { format!("{}…", first_units(line, MAX - 1)) } else { line.to_owned() })
}

struct Progress {
    /// What the chat's row keeps (the first 256K).
    output: String,
    output_units: usize,
    pending: String,
    streamed_units: usize,
    truncated: bool,
    kill_note: Option<&'static str>,
    /// The armed flush, by number.
    flush: Option<u64>,
    flushes: u64,
    finished: bool,
}

struct Run {
    id: String,
    worker_id: Option<String>,
    command: String,
    cwd: String,
    started_at: i64,
    job: JobHandle,
    handle: OnceLock<Arc<dyn RunningCommand>>,
    progress: Mutex<Progress>,
    timers: tokio::runtime::Handle,
}

impl Run {
    fn progress(&self) -> MutexGuard<'_, Progress> {
        self.progress.lock().unwrap_or_else(|p| p.into_inner())
    }
}

struct Inner {
    commands: Arc<dyn ShellCommands>,
    store: Arc<dyn Store>,
    bus: Bus,
    jobs: JobRegistry,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
}

/// What the runs are built from.
#[allow(missing_debug_implementations)]
pub struct RunDeps {
    pub commands: Arc<dyn ShellCommands>,
    pub store: Arc<dyn Store>,
    pub bus: Bus,
    pub jobs: JobRegistry,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
}

#[derive(Clone)]
pub(crate) struct Runs {
    inner: Arc<Inner>,
}

impl Runs {
    pub(crate) fn new(deps: RunDeps) -> Self {
        let RunDeps { commands, store, bus, jobs, clock, ids } = deps;
        Self { inner: Arc::new(Inner { commands, store, bus, jobs, clock, ids, runs: Mutex::new(HashMap::new()) }) }
    }

    /// The folder a run in `path` would use, or `None` when it is not there.
    pub(crate) async fn folder(&self, path: String) -> Option<String> {
        let commands = self.inner.commands.clone();
        tokio::task::spawn_blocking(move || commands.folder(&path)).await.ok().flatten()
    }

    /// Starts `command` in `cwd` and returns the run's id. Must run inside
    /// the async runtime.
    pub(crate) fn run(&self, worker_id: Option<&str>, cwd: &str, command: &str) -> String {
        let inner = &self.inner;
        let id = inner.ids.uuid();
        let started_at = inner.clock.now_ms();

        let mut spec = JobSpec::new("shell", worker_id, format!("run-{id}"), command);
        spec.command = Some(command.to_owned());
        spec.started_at = Some(started_at);
        spec.memory_output = true;
        let (stopper, run_id) = (Arc::downgrade(inner), id.clone());
        let job = inner.jobs.start(spec.on_stop(move || {
            let stopped = stopper.upgrade().is_some_and(|inner| inner.terminate(&run_id, STOPPED));
            async move {
                if stopped {
                    Ok(())
                } else {
                    Err(JobActionError { status: 409, error: "the command already ended".into() })
                }
            }
        }));

        let run = Arc::new(Run {
            id: id.clone(),
            worker_id: worker_id.map(str::to_owned),
            command: command.to_owned(),
            cwd: cwd.to_owned(),
            started_at,
            job,
            handle: OnceLock::new(),
            progress: Mutex::new(Progress {
                output: String::new(),
                output_units: 0,
                pending: String::new(),
                streamed_units: 0,
                truncated: false,
                kill_note: None,
                flush: None,
                flushes: 0,
                finished: false,
            }),
            timers: tokio::runtime::Handle::current(),
        });
        inner.runs().insert(id.clone(), run.clone());
        let start = TerminalStart {
            worker_id: run.worker_id.clone(),
            run_id: id.clone(),
            command: run.command.clone(),
            started_at,
        };
        inner.bus.publish(&TERMINAL_START, &start);
        run.job.update_now(|_| {});

        let sink = Sink { inner: inner.clone(), run: run.clone() };
        let handle = inner.commands.run(cwd, command, TIMEOUT, Box::new(sink));
        let _ = run.handle.set(handle);
        // A stop that came before the handle was there.
        if run.progress().kill_note.is_some()
            && let Some(handle) = run.handle.get()
        {
            handle.kill();
        }
        id
    }

    /// Stops a run; `false` when it already ended (or never was).
    pub(crate) fn kill(&self, run_id: &str) -> bool {
        self.inner.terminate(run_id, STOPPED)
    }

    /// Ends every run (shutdown).
    pub(crate) fn shutdown(&self) {
        let runs: Vec<Arc<Run>> = self.inner.runs().values().cloned().collect();
        for run in runs {
            if let Some(handle) = run.handle.get() {
                handle.kill();
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn running(&self) -> usize {
        self.inner.runs().len()
    }
}

impl Inner {
    fn runs(&self) -> MutexGuard<'_, HashMap<String, Arc<Run>>> {
        self.runs.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn terminate(&self, run_id: &str, note: &'static str) -> bool {
        let Some(run) = self.runs().get(run_id).cloned() else { return false };
        {
            let mut progress = run.progress();
            if progress.finished {
                return false;
            }
            progress.kill_note = Some(note);
        }
        if let Some(handle) = run.handle.get() {
            handle.kill();
        }
        true
    }

    fn flush(&self, run: &Run, progress: &mut Progress) {
        progress.flush = None;
        if progress.pending.is_empty() {
            return;
        }
        let data = std::mem::take(&mut progress.pending);
        run.job.append_output(&data);
        if let Some(last) = data.split('\n').map(eos_domain::text::js_trim).rfind(|l| !l.is_empty()) {
            let detail = first_line(last);
            run.job.update(|job| job.detail = detail);
        }
        let chunk = TerminalChunk {
            worker_id: run.worker_id.clone(),
            run_id: run.id.clone(),
            command: run.command.clone(),
            data,
        };
        self.bus.publish(&TERMINAL_CHUNK, &chunk);
    }

    fn output(self: &Arc<Self>, run: &Arc<Run>, raw: &str) {
        let text = strip_ansi(raw);
        if text.is_empty() {
            return;
        }
        let too_much = {
            let mut progress = run.progress();
            if progress.finished {
                return;
            }
            let size = units(&text);
            progress.streamed_units += size;
            if progress.output_units < MAX_SAVED_UNITS {
                let kept = first_units(&text, MAX_SAVED_UNITS - progress.output_units);
                progress.truncated |= kept.len() < text.len();
                progress.output_units += units(kept);
                progress.output.push_str(kept);
            } else {
                progress.truncated = true;
            }
            progress.pending.push_str(&text);
            if units(&progress.pending) >= FLUSH_UNITS {
                self.flush(run, &mut progress);
            } else if progress.flush.is_none() {
                progress.flushes += 1;
                let flush = progress.flushes;
                progress.flush = Some(flush);
                let (inner, run) = (Arc::downgrade(self), Arc::downgrade(run));
                let timers = match run.upgrade() {
                    Some(run) => run.timers.clone(),
                    None => return,
                };
                timers.spawn(async move {
                    tokio::time::sleep(FLUSH_WINDOW).await;
                    let (Some(inner), Some(run)) = (inner.upgrade(), run.upgrade()) else { return };
                    let mut progress = run.progress();
                    if progress.flush == Some(flush) && !progress.finished {
                        inner.flush(&run, &mut progress);
                    }
                });
            }
            progress.streamed_units > MAX_STREAMED_UNITS && progress.kill_note.is_none()
        };
        if too_much {
            self.terminate(&run.id, TOO_MUCH);
        }
    }

    /// The run is over: its last output goes out, its row is saved, the job ends.
    fn finish(self: &Arc<Self>, run: &Arc<Run>, code: Option<i32>, signal: Option<String>, failure: Option<String>) {
        let (output, truncated, kill_note) = {
            let mut progress = run.progress();
            if progress.finished {
                return;
            }
            self.flush(run, &mut progress);
            progress.finished = true;
            (std::mem::take(&mut progress.output), progress.truncated, progress.kill_note)
        };
        self.runs().remove(&run.id);

        let exit_code = code.unwrap_or(i32::from(signal.is_some()));
        let note = failure.or(kill_note.map(str::to_owned));
        let now = self.clock.now_ms();
        let status = if note.as_deref() == Some(STOPPED) {
            JobStatus::Stopped
        } else if exit_code == 0 {
            JobStatus::Completed
        } else {
            JobStatus::Failed
        };
        let detail = note.clone().unwrap_or_else(|| format!("exit {exit_code}"));
        run.job.finish(status, |job| {
            job.detail = Some(detail);
            job.exit_code = Some(i64::from(exit_code));
        });

        let done =
            TerminalDone { worker_id: run.worker_id.clone(), run_id: run.id.clone(), exit_code, note: note.clone() };
        let Some(worker_id) = run.worker_id.clone() else {
            self.bus.publish(&TERMINAL_DONE, &done);
            return;
        };
        // The row, then the events that tell of it, in that order.
        let (inner, run) = (self.clone(), run.clone());
        run.timers.clone().spawn(async move {
            let (announce, saved_run, saved_done) = (worker_id.clone(), run.clone(), done.clone());
            let saved = inner
                .store
                .write(move |tx, out| {
                    let row = TerminalRow {
                        run_id: &saved_run.id,
                        command: &saved_run.command,
                        cwd: &saved_run.cwd,
                        output: &output,
                        exit_code,
                        signal: signal.as_deref(),
                        note: note.as_deref(),
                        truncated,
                        duration_ms: now - saved_run.started_at,
                    };
                    tx.events().append_json(&announce, now, WorkerEventType::Terminal, &row)?;
                    out.push(topics::TERMINAL_DONE, &saved_done);
                    out.push(topics::WORKER_CHANGE, &WorkerChange { worker_id: &announce });
                    Ok(())
                })
                .await;
            if let Err(e) = saved {
                // The command still ended, whatever became of its row.
                tracing::warn!(run = %run.id, error = %e, "the terminal row was not saved");
                inner.bus.publish(&TERMINAL_DONE, &done);
                inner.bus.publish_raw(
                    topics::WORKER_CHANGE,
                    None,
                    serde_json::to_vec(&WorkerChange { worker_id: &worker_id }).unwrap_or_default().into(),
                );
            }
        });
    }
}

struct Sink {
    inner: Arc<Inner>,
    run: Arc<Run>,
}

impl CommandEvents for Sink {
    fn output(&mut self, text: &str) {
        self.inner.output(&self.run, text);
    }

    fn exit(&mut self, exit: CommandExit) {
        if exit.timed_out {
            let mut progress = self.run.progress();
            progress.kill_note.get_or_insert(TIMED_OUT);
        }
        self.inner.finish(&self.run, exit.code, exit.signal, None);
    }

    fn failed(&mut self, reason: String) {
        self.inner.finish(&self.run, Some(127), None, Some(format!("bash spawn failed: {reason}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_are_counted_and_cut_as_javascript_does() {
        assert_eq!(units("a漢😀"), 4);
        assert_eq!(first_units("a漢😀b", 2), "a漢");
        assert_eq!(first_units("a漢😀b", 3), "a漢", "never half an emoji");
        assert_eq!(first_units("ab", 9), "ab");
    }

    #[test]
    fn a_jobs_line_is_the_first_one_with_text() {
        assert_eq!(first_line("\n   \n  compiling  \nnext"), Some("compiling".to_owned()));
        assert_eq!(first_line("  \n"), None);
        let long = "x".repeat(200);
        let line = first_line(&long).expect("a line");
        assert_eq!(line.chars().count(), 160);
        assert!(line.ends_with('…'));
    }
}
