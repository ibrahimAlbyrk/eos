//! A flood through a terminal: how fast output travels from the PTY to a
//! client's event stream, and what the app holds while it does. Timing
//! checks, so they are ignored by default: `scripts/perf.sh` runs them in a
//! release build and prints the numbers.
//!
//! The path measured: PTY → reader thread → batching → screen mirror → bus →
//! stream hub → the stream's reader (what the shell's bridge hands to the
//! page). The shell stands in for the user's: `/bin/sh` with nobody's profile.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use eos_core::{RandomIds, SystemClock};
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_terminals::{RunDeps, SessionDeps, TerminalsModule};
use eos_platform::PosixShell;
use eos_pty::{ClaudeTranscriptFiles, PtyTerminals, Screen, ShellRunner};
use eos_runtime::access::Caller;
use eos_runtime::http::{Body, Method, Request};
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClaudeEnv, FakeClaudeProgram, TempStore};
use serde_json::{Value, json};

const MEGABYTE: usize = 1024 * 1024;
const FLOOD: usize = 64 * MEGABYTE;
const MARKER: &str = "FLOOD-IS-OVER";

/// A stand-in for the user's shell: `/bin/sh` that reads no profile
/// (`<shell> -l -i -c <line>` runs the line; `<shell> -l` is the prompt).
fn plain_shell(dir: &Path) -> &'static PosixShell {
    let path = dir.join("plain-sh");
    std::fs::write(&path, "#!/bin/sh\nif [ \"$3\" = -c ]; then exec /bin/sh -c \"$4\"; fi\nexec /bin/sh\n")
        .expect("the script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("executable");
    Box::leak(Box::new(PosixShell::fixed(path.to_string_lossy())))
}

/// Lines of text, `bytes` in all, written a megabyte at a time: the text is
/// never in this process's memory at once.
fn text_file(dir: &Path, bytes: usize) -> std::path::PathBuf {
    use std::io::Write as _;
    let path = dir.join("big.txt");
    let line = format!("{}\n", "The quick brown fox jumps over the lazy dog. ".repeat(3).trim_end());
    let block = line.repeat(MEGABYTE / line.len());
    let mut out = std::fs::File::create(&path).expect("the file");
    for _ in 0..bytes / block.len() {
        out.write_all(block.as_bytes()).expect("written");
    }
    path
}

fn resident_megabytes() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output();
    let kilobytes: f64 = out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0.0);
    kilobytes / 1024.0
}

struct App {
    runtime: Runtime,
    dir: tempfile::TempDir,
    _store: TempStore,
}

fn app() -> App {
    let dir = tempfile::tempdir().expect("a folder");
    let shell = plain_shell(dir.path());
    let store = TempStore::new();
    let kernel = Kernel::new(KernelOptions::default());
    let trees = ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
    let module = TerminalsModule::new(
        SessionDeps {
            terminals: Arc::new(PtyTerminals::new(shell)),
            claude: Arc::new(FakeClaudeProgram(None)),
            claude_env: Arc::new(FakeClaudeEnv(None)),
            bus: kernel.bus.clone(),
            ids: Arc::new(RandomIds),
            clock: Arc::new(SystemClock),
            default_cwd: dir.path().to_string_lossy().into_owned(),
        },
        Arc::new(ClaudeTranscriptFiles::new(dir.path())),
        RunDeps {
            commands: Arc::new(ShellRunner::new(Runner::new(trees), shell, None)),
            store: store.port(),
            bus: kernel.bus.clone(),
            jobs: kernel.jobs.clone(),
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomIds),
        },
    );
    let runtime = Runtime::build(kernel, vec![Arc::new(module)], Arc::new(AllPluginsOn)).expect("composes");
    App { runtime, dir, _store: store }
}

impl App {
    async fn json(&self, method: Method, target: &str, body: Option<Value>) -> Value {
        let mut req = Request::new(method, target, Caller::DASHBOARD);
        if let Some(body) = body {
            req = req.body(body.to_string());
        }
        let res = self.runtime.router.handle(req).await;
        assert_eq!(res.status, 200, "{target}");
        serde_json::from_slice(&res.body.collect().await.expect("a body")).expect("json")
    }

    async fn terminal(&self) -> String {
        let session = self.json(Method::Post, "/pty", Some(json!({ "cols": 120, "rows": 40 }))).await;
        session["sessionId"].as_str().expect("an id").to_owned()
    }

    async fn flood(&self, id: &str, file: &Path) {
        // The marker is typed in two halves, so the echo of this line is not the marker.
        let (head, rest) = MARKER.split_at(6);
        let line = format!("stty -echo; cat {}; echo {head}\"\"{rest}\r", file.display());
        self.json(Method::Post, &format!("/pty/{id}/input"), Some(json!({ "data": line }))).await;
    }

    /// Waits until the mirror has seen the end of the flood.
    async fn mirror_has_the_end(&self, id: &str) {
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            let buffer = self.json(Method::Get, &format!("/pty/{id}/buffer"), None).await;
            if buffer["data"].as_str().is_some_and(|d| d.contains(MARKER)) {
                return;
            }
            assert!(Instant::now() < deadline, "the flood never ended");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// Samples this process's memory until dropped; the peak is what it kept.
struct MemoryWatch {
    peak: Arc<AtomicU64>,
    task: tokio::task::JoinHandle<()>,
}

impl MemoryWatch {
    fn start() -> Self {
        let peak = Arc::new(AtomicU64::new(0));
        let seen = peak.clone();
        let task = tokio::spawn(async move {
            loop {
                let now = tokio::task::spawn_blocking(resident_megabytes).await.unwrap_or(0.0);
                seen.fetch_max(now as u64, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
        Self { peak, task }
    }

    fn peak(&self) -> u64 {
        self.peak.load(Ordering::Relaxed)
    }
}

impl Drop for MemoryWatch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "a timing check: scripts/perf.sh"]
async fn a_flood_reaches_a_client_that_keeps_reading() {
    let app = app();
    let file = text_file(app.dir.path(), FLOOD);
    let id = app.terminal().await;
    let before = resident_megabytes();
    let watch = MemoryWatch::start();

    // A client as the dashboard is one: it reads the stream, and when the
    // stream ends on it for falling behind, it comes back from its last id.
    let target = |since: Option<&str>| {
        let since = since.map(|id| format!("&since={id}")).unwrap_or_default();
        format!("/stream?topics=pty:data&clientId=flood&focus=&ptys={id}{since}")
    };
    let router = app.runtime.router.clone();
    let open = |target: String| {
        let router = router.clone();
        async move {
            let res = router.handle(Request::new(Method::Get, &target, Caller::DASHBOARD)).await;
            match res.body {
                Body::Stream(stream) => stream,
                _ => panic!("a stream"),
            }
        }
    };
    let mut stream = open(target(None)).await;
    app.flood(&id, &file).await;

    let started = Instant::now();
    let (mut bytes, mut frames, mut reconnects, mut resyncs) = (0usize, 0u64, 0u32, 0u32);
    let mut last_id: Option<String> = None;
    let mut tail = String::new();
    let done = loop {
        let Some(Ok(frame)) = stream.next().await else {
            reconnects += 1;
            stream = open(target(last_id.as_deref())).await;
            continue;
        };
        let text = String::from_utf8_lossy(&frame);
        if let Some(id) = text.lines().find_map(|l| l.strip_prefix("id: ")) {
            last_id = Some(id.to_owned());
        }
        if text.contains("event: resync") {
            resyncs += 1;
        }
        if !text.contains("\"pty:data\"") {
            continue;
        }
        frames += 1;
        bytes += frame.len();
        // The marker may straddle two frames.
        tail.push_str(&text[text.len().saturating_sub(4096)..]);
        if tail.contains(MARKER) {
            break started.elapsed();
        }
        tail = tail.split_off(tail.len().saturating_sub(MARKER.len()));
    };
    app.mirror_has_the_end(&id).await;

    let megabytes = FLOOD as f64 / MEGABYTE as f64;
    let rate = megabytes / done.as_secs_f64();
    println!(
        "flood, client reading: {megabytes:.0} MB of terminal output in {:.2} s = {rate:.1} MB/s; {frames} frames ({:.1} MB on the stream), {reconnects} reconnects, {resyncs} resyncs; memory {before:.0} MB before, {} MB at its peak",
        done.as_secs_f64(),
        bytes as f64 / MEGABYTE as f64,
        watch.peak()
    );
    assert!(rate > 5.0, "{rate:.1} MB/s");
    assert!((watch.peak() as f64) < before + 300.0, "memory grew past its bounds");
    app.runtime.shutdown(Duration::from_secs(5)).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "a timing check: scripts/perf.sh"]
async fn a_flood_does_not_wait_for_a_client_that_stopped_reading() {
    let app = app();
    let file = text_file(app.dir.path(), FLOOD);
    let id = app.terminal().await;
    let before = resident_megabytes();
    let watch = MemoryWatch::start();

    // A stream that is opened and never read: the page hung, or is gone.
    let target = format!("/stream?topics=pty:data&clientId=stalled&focus=&ptys={id}");
    let stalled = app.runtime.router.handle(Request::new(Method::Get, &target, Caller::DASHBOARD)).await;

    let started = Instant::now();
    app.flood(&id, &file).await;
    app.mirror_has_the_end(&id).await;
    let done = started.elapsed();
    let megabytes = FLOOD as f64 / MEGABYTE as f64;
    println!(
        "flood, client stalled: {megabytes:.0} MB in {:.2} s = {:.1} MB/s through the mirror; memory {before:.0} MB before, {} MB at its peak",
        done.as_secs_f64(),
        megabytes / done.as_secs_f64(),
        watch.peak()
    );
    // The app answers meanwhile and afterwards, and holds a bounded amount.
    assert_eq!(app.json(Method::Get, "/pty", None).await["sessions"].as_array().map(Vec::len), Some(1));
    assert!((watch.peak() as f64) < before + 300.0, "memory grew past its bounds");
    drop(stalled);
    app.runtime.shutdown(Duration::from_secs(5)).await;
}

#[test]
#[ignore = "a timing check: scripts/perf.sh"]
fn the_mirror_keeps_up_with_a_flood() {
    let dir = tempfile::tempdir().expect("a folder");
    let text = std::fs::read_to_string(text_file(dir.path(), FLOOD)).expect("the file").replace('\n', "\r\n");
    let mut screen = Screen::new(120, 40);
    let started = Instant::now();
    for chunk in text.as_bytes().chunks(32 * 1024) {
        screen.write(std::str::from_utf8(chunk).expect("ascii"));
    }
    let wrote = started.elapsed();
    let started = Instant::now();
    let snapshot = screen.snapshot();
    let rate = text.len() as f64 / MEGABYTE as f64 / wrote.as_secs_f64();
    println!(
        "mirror alone: {rate:.0} MB/s; a snapshot of the full history ({} KB) in {:.1} ms",
        snapshot.len() / 1024,
        started.elapsed().as_secs_f64() * 1000.0
    );
    assert!(rate > 20.0, "{rate:.0} MB/s");
}
