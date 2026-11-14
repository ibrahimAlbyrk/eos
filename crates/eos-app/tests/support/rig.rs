//! What the long runs share (the soak, the lifetime tests, the crash tests):
//! the whole app on a data folder with a scripted agent engine, calls through
//! its router, a turn of a chosen kind for every message, and the process
//! gauges a run is judged by.
#![allow(dead_code, unreachable_pub)]

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use eos_app::{AgentOptions, App, Options};
use eos_contracts::{AgentEvent, WorkflowRunProgress};
use eos_core::BoxFuture;
use eos_core::accounts::SessionCredential;
use eos_core::agent::{
    BackgroundTaskKind, BackgroundTaskUpdate, OneShot, OneShotAnswer, OneShotError, OneShotRequest, TaskOutcome,
};
use eos_runtime::access::Caller;
use eos_runtime::http::{Body, BodyStream, Method, Request};
use eos_testkit::ScriptedRuntime;
use eos_testkit::agent::{Turn, events};
use serde_json::{Value, json};

/// Builds the app on `home` with `agents` for every session and a summarizer
/// that always answers. Peers, the relay, launchd and the leftover sweep stay off.
pub fn build(home: &Path, agents: &ScriptedRuntime) -> App {
    let options = Options {
        launchd: None,
        agents: AgentOptions {
            claude_home: Some(home.join("claude-home")),
            no_mcp: true,
            credential: Some(SessionCredential::ApiKey { provider: "anthropic".into(), key: "k-rig".into() }),
            runtime: Some(agents.port()),
            one_shot: Some(Arc::new(Summarizer)),
            ..AgentOptions::default()
        },
        ..Options::new(home)
    };
    App::build(options).expect("the app builds")
}

/// The dashboard: the caller that holds the ui-token.
pub fn dashboard(app: &App) -> Caller {
    app.callers().classify(Some(app.callers().ui_token()))
}

/// One request as the dashboard; the whole answer.
pub async fn call(app: &App, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
    let (status, bytes) = call_bytes(app, dashboard(app), method, target, body).await;
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// One request as `caller`; the answer's bytes, also of a list sent in
/// slices (the event stream's, which never end, are not read).
pub async fn call_bytes(app: &App, caller: Caller, method: Method, target: &str, body: Option<Value>) -> (u16, Bytes) {
    let mut request = Request::new(method, target, caller);
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body.to_string());
    }
    let response = app.router().handle(request).await;
    let status = response.status;
    let bytes = match response.body {
        Body::Stream(_) if target.starts_with("/stream") => Bytes::new(),
        body => body.collect().await.unwrap_or_default(),
    };
    (status, bytes)
}

/// Opens the event stream as the dashboard (`query` without the `?`).
pub async fn open_stream(app: &App, query: &str) -> Option<BodyStream> {
    let target = if query.is_empty() { "/stream".to_owned() } else { format!("/stream?{query}") };
    let response = app.router().handle(Request::new(Method::Get, &target, dashboard(app))).await;
    match response.body {
        Body::Stream(stream) => Some(stream),
        _ => None,
    }
}

/// A one-shot model that always answers: summaries for compaction, names
/// for chats. Keeps nothing.
pub struct Summarizer;

impl OneShot for Summarizer {
    fn complete(&self, request: OneShotRequest) -> BoxFuture<'_, Result<OneShotAnswer, OneShotError>> {
        let answer = match request.schema {
            Some(_) => OneShotAnswer { text: String::new(), structured: Some(json!({"name": "Soak chat"})) },
            None => OneShotAnswer { text: "Summary: the work so far, in a few lines.".into(), structured: None },
        };
        Box::pin(std::future::ready(Ok(answer)))
    }
}

/// The kinds of turn a message can ask for with `[kind]` in its text.
pub const KINDS: [&str; 8] = ["reply", "tools", "subagent", "background", "workflow", "long", "big", "failing"];

static CALLS: AtomicU64 = AtomicU64::new(0);

fn event(value: Value) -> AgentEvent {
    match serde_json::from_value(value.clone()) {
        Ok(event) => event,
        Err(e) => panic!("a canonical event: {e}: {value}"),
    }
}

/// The context a session reports filling: past the compaction threshold at 950,000.
pub fn context(tokens: u64) -> AgentEvent {
    event(json!({"type": "context", "tokens": tokens}))
}

/// The turn for a message: the kind named in it as `[kind]`, else a reply.
/// Every call id is unique in the process.
pub fn turn_for(worker_id: &str, text: &str) -> Turn {
    let kind = KINDS.iter().find(|k| text.contains(&format!("[{k}]"))).copied().unwrap_or("reply");
    let n = CALLS.fetch_add(1, Ordering::Relaxed);
    let call = format!("toolu_{n}");
    let reasoning = event(json!({"type": "message", "role": "assistant",
        "blocks": [{"type": "reasoning", "text": "Thinking about it.", "blockId": format!("r{n}:0")}]}));
    let answer = |text: &str| events::text(text, &format!("m{n}:1"));
    match kind {
        "tools" => Turn::of(vec![
            reasoning,
            event(json!({"type": "activity", "kind": "tool_started", "callId": call, "toolName": "Read"})),
            events::tool_call(
                &call,
                "Read",
                serde_json::from_value(json!({"file_path": "README.md"})).unwrap_or_default(),
            ),
            events::tool_result(&call, "# project\n\nA throwaway repository.\n", false),
            event(json!({"type": "activity", "kind": "tool_finished", "callId": call, "toolName": "Read"})),
            answer("The readme says it is a throwaway repository."),
        ]),
        "subagent" => {
            let agent = format!("agent-{n}");
            Turn::of(vec![
                events::tool_call(
                    &call,
                    "Task",
                    serde_json::from_value(json!({"description": "look around", "prompt": "Look around."}))
                        .unwrap_or_default(),
                ),
                event(
                    json!({"type": "subagent_started", "callId": call, "agentId": agent, "background": false, "description": "look around"}),
                ),
                event(json!({"type": "subagent_profile", "callId": call, "model": "claude-haiku-4-5"})),
                event(
                    json!({"type": "subagent_completed", "agentId": agent, "callId": call, "status": "completed", "result": "Nothing odd."}),
                ),
                events::tool_result(&call, "Nothing odd.", false),
                answer("The subagent found nothing odd."),
            ])
        }
        "background" => {
            let task = format!("bg{n}");
            Turn::of(vec![
                events::tool_call(
                    &call,
                    "Bash",
                    serde_json::from_value(json!({"command": "sleep 1", "run_in_background": true}))
                        .unwrap_or_default(),
                ),
                events::tool_result(&call, "Command running in background", false),
                answer("Started it in the background."),
            ])
            .with_background(BackgroundTaskUpdate::Started {
                task_id: task.clone(),
                call_id: call.clone(),
                kind: BackgroundTaskKind::Shell,
                title: "sleep 1".into(),
                command: Some("sleep 1".into()),
                output_file: None,
            })
            .with_background(BackgroundTaskUpdate::Ended {
                task_id: task,
                outcome: TaskOutcome::Completed,
                summary: Some("done".into()),
                output_file: None,
                exit_code: Some(0),
            })
        }
        "workflow" => {
            let task = format!("wf{n}");
            let snapshot = json!({"phases": [{"index": 0, "title": "Look"}], "agents": [], "logs": ["started"]});
            let progress = |status: &str| -> WorkflowRunProgress {
                serde_json::from_value(json!({"workerId": worker_id, "callId": call, "taskId": task, "status": status,
                    "snapshot": snapshot, "updatedAt": 1}))
                .expect("a workflow snapshot")
            };
            Turn::of(vec![
                events::tool_call(&call, "Workflow", serde_json::from_value(json!({"script": "export const meta = {}"})).unwrap_or_default()),
                event(json!({"type": "workflow_started", "callId": call, "taskId": task, "runId": format!("run{n}"), "name": "look", "description": "a look"})),
                event(json!({"type": "workflow_completed", "callId": call, "taskId": task, "status": "completed", "summary": "looked", "snapshot": snapshot})),
                answer("The workflow is done."),
            ])
            .with_workflow(progress("running"))
            .with_workflow(progress("completed"))
        }
        "long" => Turn::of(vec![reasoning, answer("That took a while.")]).taking(Duration::from_millis(1500)),
        "big" => {
            // Past the compaction threshold: the idle edge compacts the chat.
            Turn::of(vec![answer("A long conversation by now."), context(950_000)])
        }
        "failing" => Turn::of(vec![answer("Something broke.")]).failing("overloaded"),
        _ => Turn::of(vec![reasoning, answer("Done.")]),
    }
}

/// What a process looks like at one moment.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub at_secs: f64,
    pub rss_kb: u64,
    /// What the system counts against the process (Activity Monitor's figure).
    pub footprint_kb: u64,
    /// Bytes the allocator has handed out and not got back: the measure of a
    /// leak (resident memory also holds what the allocator keeps for reuse).
    pub malloc_kb: u64,
    pub fds: usize,
    pub threads: usize,
    pub tasks: usize,
    pub db_kb: u64,
    pub wal_kb: u64,
    pub writes_queued: usize,
    pub sessions: usize,
}

impl Sample {
    pub const HEADER: &'static str =
        "secs,rss_kb,footprint_kb,malloc_kb,fds,threads,tasks,db_kb,wal_kb,writes_queued,sessions";

    pub fn csv(&self) -> String {
        format!(
            "{:.0},{},{},{},{},{},{},{},{},{},{}",
            self.at_secs,
            self.rss_kb,
            self.footprint_kb,
            self.malloc_kb,
            self.fds,
            self.threads,
            self.tasks,
            self.db_kb,
            self.wal_kb,
            self.writes_queued,
            self.sessions
        )
    }
}

fn ps(args: &[&str]) -> String {
    std::process::Command::new("ps")
        .args(args)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default()
}

/// This process's resident memory, in KB.
pub fn rss_kb() -> u64 {
    ps(&["-o", "rss=", "-p", &std::process::id().to_string()]).trim().parse().unwrap_or(0)
}

fn kb_of(text: &str) -> Option<u64> {
    let (number, unit) = text.split_at(text.find(|c: char| c.is_ascii_alphabetic())?);
    let value: f64 = number.parse().ok()?;
    let scale = match unit.chars().next()? {
        'K' => 1.0,
        'M' => 1024.0,
        'G' => 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * scale) as u64)
}

/// This process's footprint and the bytes its allocator holds out, in KB
/// (`vmmap -summary`; about a second).
pub fn memory_kb() -> (u64, u64) {
    let out = std::process::Command::new("vmmap")
        .args(["-summary", &std::process::id().to_string()])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();
    let footprint = out
        .lines()
        .find_map(|line| line.strip_prefix("Physical footprint:").and_then(|v| kb_of(v.trim())))
        .unwrap_or(0);
    // The zone table comes last, under its own header line.
    let allocated = out
        .lines()
        .skip_while(|line| !line.starts_with("MALLOC ZONE"))
        .find(|line| line.starts_with("TOTAL"))
        .and_then(|line| line.split_whitespace().nth(6))
        .and_then(kb_of)
        .unwrap_or(0);
    (footprint, allocated)
}

/// This process's threads.
pub fn threads() -> usize {
    ps(&["-M", "-p", &std::process::id().to_string()]).lines().count().saturating_sub(1)
}

/// This process's open file descriptors.
pub fn fds() -> usize {
    std::fs::read_dir("/dev/fd").map(|dir| dir.count()).unwrap_or(0)
}

fn kb(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len() / 1024).unwrap_or(0)
}

/// Samples the process and the app.
pub fn sample(app: &App, agents: &ScriptedRuntime, at_secs: f64) -> Sample {
    let db = app.paths().state_db();
    let stats = app.db_stats();
    let (footprint_kb, malloc_kb) = memory_kb();
    Sample {
        at_secs,
        rss_kb: rss_kb(),
        footprint_kb,
        malloc_kb,
        fds: fds(),
        threads: threads(),
        tasks: tokio::runtime::Handle::current().metrics().num_alive_tasks(),
        db_kb: kb(&db),
        wal_kb: kb(&db.with_extension("db-wal")),
        writes_queued: stats.writes_queued,
        sessions: eos_core::agent::AgentRuntime::live(agents),
    }
}

/// Least-squares slope of `y` over `x`, per unit of `x`.
pub fn slope(points: &[(f64, f64)]) -> f64 {
    let n = points.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let (sx, sy) = points.iter().fold((0.0, 0.0), |(a, b), (x, y)| (a + x, b + y));
    let (mx, my) = (sx / n, sy / n);
    let (num, den) =
        points.iter().fold((0.0, 0.0), |(a, b), (x, y)| (a + (x - mx) * (y - my), b + (x - mx) * (x - mx)));
    if den == 0.0 { 0.0 } else { num / den }
}

/// A small seeded generator (SplitMix64): every run with one seed makes the same choices.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in `0..n`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }

    pub fn chance(&mut self, percent: u64) -> bool {
        self.next_u64() % 100 < percent
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// The frames of one open stream, parsed as they arrive.
pub struct Frames {
    stream: BodyStream,
    buf: String,
    /// The `id:` of the last frame read.
    pub last_id: Option<String>,
}

impl Frames {
    pub fn new(stream: BodyStream) -> Self {
        Self { stream, buf: String::new(), last_id: None }
    }

    /// The next frame's data (`None` when the stream ended or nothing came in `wait`).
    pub async fn next(&mut self, wait: Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Some(end) = self.buf.find("\n\n") {
                let frame: String = self.buf.drain(..end + 2).collect();
                let mut data = None;
                for line in frame.lines() {
                    if let Some(id) = line.strip_prefix("id: ") {
                        self.last_id = Some(id.to_owned());
                    } else if let Some(text) = line.strip_prefix("data: ") {
                        data = serde_json::from_str(text).ok();
                    }
                }
                match data {
                    Some(value) => return Some(value),
                    None => continue,
                }
            }
            let chunk = tokio::time::timeout_at(deadline, self.stream.next()).await.ok()??.ok()?;
            self.buf.push_str(&String::from_utf8_lossy(&chunk));
        }
    }

    /// Reads until a frame matches; `None` if none did in `wait`.
    pub async fn until(&mut self, wait: Duration, matches: impl Fn(&Value) -> bool) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            let frame = self.next(left).await?;
            if matches(&frame) {
                return Some(frame);
            }
        }
    }
}

/// A `worker:change` frame saying `worker` is now `state`.
pub fn went(frame: &Value, worker: &str, state: &str) -> bool {
    frame["reason"] == "worker:change" && frame["payload"]["workerId"] == worker && frame["payload"]["state"] == state
}

/// Starts a focused chat in `cwd` with a first message; its id.
pub async fn focused_chat(app: &App, cwd: &str, prompt: &str) -> String {
    let (status, created) =
        call(app, Method::Post, "/orchestrators", Some(json!({"mode": "focused", "cwd": cwd, "prompt": prompt}))).await;
    assert_eq!(status, 201, "{created}");
    created["id"].as_str().expect("an id").to_owned()
}
