//! Today's TypeScript peer code as a test partner: a `node` child running
//! `tests/node/harness.ts` from this checkout, driven in JSON lines.
//!
//! The harness needs `node` (22.18 or newer: it runs TypeScript directly) and
//! `npm ci` in `crates/eos-peer/tests/node`. Without either a test that asks
//! for it is skipped, saying so.

#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

pub(crate) const WAIT: Duration = Duration::from_secs(30);

fn harness_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/node")
}

pub(crate) struct Node {
    // Killed when dropped: the only process these tests ever signal.
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Node {
    /// The harness, or `None` (after saying why) when this machine cannot run it.
    pub(crate) async fn start() -> Option<Self> {
        let dir = harness_dir();
        if !dir.join("node_modules/zod").is_dir() || !dir.join("node_modules/ws").is_dir() {
            eprintln!("skipped: run `npm ci` in crates/eos-peer/tests/node to test against the TypeScript peer code");
            return None;
        }
        let spawned = Command::new("node")
            .arg("run.mjs")
            .current_dir(&dir)
            // Hosting holds the system awake through `caffeinate` in today's code; a test never should.
            .env("EOS_HOME", dir.join("no-such-home"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                eprintln!("skipped: `node` could not be started ({e})");
                return None;
            }
        };
        let stdin = child.stdin.take().expect("piped stdin");
        let lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut node = Self { _child: child, stdin, lines, next_id: 0 };
        let hello = node.read().await;
        assert_eq!(hello["ready"], true, "the harness starts: {hello}");
        Some(node)
    }

    async fn read(&mut self) -> Value {
        let line = tokio::time::timeout(WAIT, self.lines.next_line())
            .await
            .expect("the harness answered in time")
            .expect("its output is readable")
            .expect("it is still running");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("a JSON line, got {line:?}: {e}"))
    }

    /// Sends a command without waiting for its answer.
    pub(crate) async fn send(&mut self, cmd: &str, mut args: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        args["seq"] = json!(id);
        args["cmd"] = json!(cmd);
        let mut line = args.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.expect("the harness reads commands");
        id
    }

    /// The answer to command `id`, success or not.
    pub(crate) async fn answer(&mut self, id: u64) -> Value {
        loop {
            let reply = self.read().await;
            if reply["seq"] == json!(id) {
                return reply;
            }
        }
    }

    /// Runs a command and returns its result; a failed command fails the test.
    pub(crate) async fn call(&mut self, cmd: &str, args: Value) -> Value {
        let id = self.send(cmd, args).await;
        let reply = self.answer(id).await;
        assert_eq!(reply["ok"], true, "{cmd} failed: {reply}");
        reply
    }

    /// Runs a command expected to fail and returns `{ error, status }`.
    pub(crate) async fn call_err(&mut self, cmd: &str, args: Value) -> Value {
        let id = self.send(cmd, args).await;
        let reply = self.answer(id).await;
        assert_eq!(reply["ok"], false, "{cmd} was expected to fail: {reply}");
        reply
    }
}
