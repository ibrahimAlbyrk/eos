//! Running a system tool to completion with a deadline and capped output.

use std::io::{Read, Write};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::Error;

/// More than any tool here prints; the rest is read and dropped.
const OUTPUT_CAP: usize = 1024 * 1024;
const POLL: Duration = Duration::from_millis(5);

pub(crate) struct ToolOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl ToolOutput {
    /// The last line the tool printed on stderr, for an error message.
    pub(crate) fn last_error_line(&self) -> Option<&str> {
        self.stderr.trim().lines().last().filter(|l| !l.is_empty())
    }
}

fn drain(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let room = OUTPUT_CAP.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..n.min(room)]);
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

/// Spawns `command`, feeds it `stdin`, and waits at most `timeout`; a tool
/// still running then is killed and reaped.
pub(crate) fn run(
    tool: &'static str,
    command: &mut Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ToolOutput, Error> {
    let mut child = command
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Tool { tool, detail: e.to_string() })?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // A tool that exits without reading gives EPIPE; its status tells the story.
        let _ = pipe.write_all(input);
    }
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::TimedOut { tool, timeout });
        }
        thread::sleep(POLL);
    };
    let text = |handle: Option<thread::JoinHandle<String>>| handle.and_then(|h| h.join().ok()).unwrap_or_default();
    Ok(ToolOutput { status, stdout: text(stdout), stderr: text(stderr) })
}

/// [`run`], where anything but exit 0 is an error carrying the tool's last stderr line.
pub(crate) fn run_ok(
    tool: &'static str,
    command: &mut Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ToolOutput, Error> {
    let out = run(tool, command, stdin, timeout)?;
    if out.status.success() {
        return Ok(out);
    }
    let detail = out.last_error_line().map_or_else(|| out.status.to_string(), str::to_owned);
    Err(Error::Tool { tool, detail })
}
