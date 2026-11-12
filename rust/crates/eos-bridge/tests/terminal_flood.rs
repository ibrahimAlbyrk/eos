//! A terminal flood as the page gets it: PTY → terminal sessions → event
//! stream → [`RouterCore`] → the transport the shell's scheme handler reads.
//! A timing check, ignored by default: `scripts/perf.sh` runs it in a release
//! build and prints the numbers.
//!
//! Two readers: one that reads as fast as it can, and one that takes 64 KB
//! every 20 ms (a page busy drawing). The slow one falls behind on purpose:
//! its stream ends, it comes back from its last event id, and when the ring
//! no longer reaches that far it is told to resync — which is when a terminal
//! view fetches the screen (`GET /pty/:id/buffer`) instead of the bytes it missed.

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eos_bridge::{Body, Core, Initiator, Plane, Read, Req, RouterCore, channel};
use eos_core::{RandomIds, SystemClock};
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_terminals::{RunDeps, SessionDeps, TerminalsModule};
use eos_platform::PosixShell;
use eos_pty::{ClaudeTranscriptFiles, PtyTerminals, ShellRunner};
use eos_runtime::access::Caller;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeClaudeEnv, FakeClaudeProgram, TempStore};
use serde_json::{Value, json};
use tokio::sync::Notify;

const MEGABYTE: f64 = 1024.0 * 1024.0;
const FLOOD: usize = 64 * 1024 * 1024;
const MARKER: &str = "FLOOD-IS-OVER";
/// How long the stream must be quiet, after the flood ended, for the page to have it all.
const QUIET: Duration = Duration::from_millis(500);

fn resident_megabytes() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output();
    out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok()).unwrap_or(0.0) / 1024.0
}

struct App {
    core: RouterCore,
    runtime: Runtime,
    dir: tempfile::TempDir,
    _store: TempStore,
}

fn app() -> App {
    let dir = tempfile::tempdir().expect("a folder");
    // A stand-in for the user's shell: `/bin/sh`, nobody's profile.
    let shell_path = dir.path().join("plain-sh");
    std::fs::write(&shell_path, "#!/bin/sh\nexec /bin/sh\n").expect("the script");
    std::fs::set_permissions(&shell_path, std::fs::Permissions::from_mode(0o755)).expect("executable");
    let shell: &'static PosixShell = Box::leak(Box::new(PosixShell::fixed(shell_path.to_string_lossy())));

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
    let core = RouterCore::new(
        runtime.router.clone(),
        "token",
        Arc::new(|_, _| Caller::DASHBOARD),
        tokio::runtime::Handle::current(),
    );
    App { core, runtime, dir, _store: store }
}

impl App {
    fn request(&self, method: &str, target: &str, body: Option<Value>) -> Body {
        let (sink, answer) = channel();
        let req = Req {
            initiator: Initiator::Document,
            method: method.to_owned(),
            url: target.to_owned(),
            headers: Vec::new(),
            body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
        };
        self.core.call(Plane::Api, req, sink);
        answer
    }

    /// A whole JSON answer.
    async fn json(&self, method: &str, target: &str, body: Option<Value>) -> Value {
        let answer = self.request(method, target, body);
        let mut bytes = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        while let Some(n) = read(&answer, &mut buf).await {
            bytes.extend_from_slice(&buf[..n]);
        }
        assert_eq!(answer.head().map(|h| h.status), Some(200), "{target}");
        serde_json::from_slice(&bytes).expect("json")
    }
}

/// One read as the scheme handler makes it; `None` at the end of the body.
async fn read(body: &Body, buf: &mut [u8]) -> Option<usize> {
    loop {
        let ready = Arc::new(Notify::new());
        let wake = ready.clone();
        match body.read(buf, move || wake.notify_one()) {
            Read::Data(n) => return Some(n),
            Read::End => return None,
            Read::Pending => ready.notified().await,
        }
    }
}

struct Seen {
    /// Until the terminal's screen had the end of the flood.
    took: Duration,
    megabytes: f64,
    reconnects: u32,
    resyncs: usize,
    peak: f64,
}

/// Floods a terminal and reads its stream until the screen has the flood's
/// end, pausing after every read.
async fn flood(pause: Duration) -> Seen {
    let app = Arc::new(app());
    let file = app.dir.path().join("big.txt");
    {
        // Written a megabyte at a time: the text is never in this process's memory at once.
        use std::io::Write as _;
        let line = "The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.\n";
        let block = line.repeat(1024 * 1024 / line.len());
        let mut out = std::fs::File::create(&file).expect("the file");
        for _ in 0..FLOOD / block.len() {
            out.write_all(block.as_bytes()).expect("written");
        }
    }
    let session = app.json("POST", "/pty", Some(json!({ "cols": 120, "rows": 40 }))).await;
    let id = session["sessionId"].as_str().expect("an id").to_owned();
    let stream = |since: Option<&str>| {
        let since = since.map(|id| format!("&since={id}")).unwrap_or_default();
        app.request("GET", &format!("/stream?topics=pty:data&clientId=flood&focus=&ptys={id}{since}"), None)
    };

    let mut body = stream(None);
    // The marker is typed in two halves, so the echo of this line is not the marker.
    let (head, rest) = MARKER.split_at(6);
    let command = format!("stty -echo; cat {}; echo {head}\"\"{rest}\r", file.display());
    app.json("POST", &format!("/pty/{id}/input"), Some(json!({ "data": command }))).await;

    let started = Instant::now();
    // When the flood is over at its source: the screen has its last line.
    let over = {
        let (app, id) = (app.clone(), id.clone());
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let buffer = app.json("GET", &format!("/pty/{id}/buffer"), None).await;
                if buffer["data"].as_str().is_some_and(|d| d.contains(MARKER)) {
                    return started.elapsed();
                }
            }
        })
    };
    let mut seen = Seen { took: Duration::ZERO, megabytes: 0.0, reconnects: 0, resyncs: 0, peak: resident_megabytes() };
    let mut buf = vec![0u8; 64 * 1024];
    let mut last_id: Option<String> = None;
    let mut reads = 0u32;
    loop {
        match tokio::time::timeout(QUIET, read(&body, &mut buf)).await {
            Ok(Some(n)) => {
                seen.megabytes += n as f64 / MEGABYTE;
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(at) = text.rfind("\nid: ") {
                    // A read can end inside the id; the next one carries a whole one.
                    if let Some(id) = text[at + 5..].split_once('\n').map(|(id, _)| id) {
                        last_id = Some(id.to_owned());
                    }
                }
                seen.resyncs += text.matches("event: resync").count();
            }
            // Fell behind: the stream ended. Back from the last id.
            Ok(None) => {
                seen.reconnects += 1;
                body = stream(last_id.as_deref());
            }
            // Quiet, and the flood is over: the page has all it is going to get.
            Err(_) if over.is_finished() => break,
            Err(_) => {}
        }
        reads += 1;
        if reads.is_multiple_of(64) {
            seen.peak = seen.peak.max(resident_megabytes());
        }
        if !pause.is_zero() {
            tokio::time::sleep(pause).await;
        }
    }
    seen.took = over.await.expect("the flood ended");
    seen.peak = seen.peak.max(resident_megabytes());
    body.cancel();
    app.runtime.shutdown(Duration::from_secs(5)).await;
    seen
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "a timing check: scripts/perf.sh"]
async fn a_terminal_flood_through_the_bridge() {
    let total = FLOOD as f64 / MEGABYTE;
    let fast = flood(Duration::ZERO).await;
    let rate = total / fast.took.as_secs_f64();
    println!(
        "bridge, page reading: {total:.0} MB of terminal output in {:.2} s = {rate:.1} MB/s ({:.1} MB of frames read, {} reconnects, {} resyncs); memory {:.0} MB at its peak",
        fast.took.as_secs_f64(),
        fast.megabytes,
        fast.reconnects,
        fast.resyncs,
        fast.peak
    );
    let slow = flood(Duration::from_millis(20)).await;
    println!(
        "bridge, page busy (64 KB per 20 ms): the terminal was through the flood in {:.2} s; the page read {:.1} MB of frames, {} reconnects, {} resyncs; memory {:.0} MB at its peak",
        slow.took.as_secs_f64(),
        slow.megabytes,
        slow.reconnects,
        slow.resyncs,
        slow.peak
    );
    assert!(rate > 5.0, "{rate:.1} MB/s");
    assert!(fast.peak < 300.0 && slow.peak < 300.0, "memory grew past its bounds");
    // A page that cannot keep up does not hold the terminal back for long.
    assert!(slow.took < Duration::from_secs(120));
}
