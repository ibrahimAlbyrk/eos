//! Running a system tool to completion with a deadline and capped output.

use std::io::{Read, Write};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::Error;

/// More than any tool here prints; the rest is read and dropped.
const OUTPUT_CAP: usize = 1024 * 1024;
const POLL: Duration = Duration::from_millis(5);
/// How long the output is waited for once the tool exited, whatever was left of its
/// deadline: a process it left behind may hold the pipe open long after.
const AFTER_EXIT: Duration = Duration::from_secs(1);

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

/// A pipe read to its end on a thread of its own, keeping at most [`OUTPUT_CAP`] bytes.
struct Drain {
    kept: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

fn drain(mut pipe: impl Read + Send + 'static) -> Drain {
    let kept: Arc<Mutex<Vec<u8>>> = Arc::default();
    let (tx, done) = mpsc::channel();
    let into = kept.clone();
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut kept = into.lock().unwrap_or_else(|p| p.into_inner());
            let room = OUTPUT_CAP.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..n.min(room)]);
        }
        let _ = tx.send(());
    });
    Drain { kept, done }
}

impl Drain {
    /// What the tool wrote, once the pipe ended, or after `wait` (from now) while something
    /// still holds it open.
    fn text(self, wait: Duration) -> String {
        let _ = self.done.recv_timeout(wait);
        String::from_utf8_lossy(&self.kept.lock().unwrap_or_else(|p| p.into_inner())).into_owned()
    }
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
    // One wait for both pipes: they end together when the tool alone held them.
    let until = Instant::now() + AFTER_EXIT;
    let text = |drain: Option<Drain>| {
        drain.map(|d| d.text(until.saturating_duration_since(Instant::now()))).unwrap_or_default()
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_comes_back_whole_with_the_status() {
        let out = run(
            "sh",
            Command::new("/bin/sh").args(["-c", "cat; echo err >&2; exit 3"]),
            Some(b"in"),
            Duration::from_secs(10),
        )
        .expect("runs");
        assert_eq!((out.stdout.as_str(), out.stderr.as_str(), out.status.code()), ("in", "err\n", Some(3)));
    }

    #[test]
    fn output_written_as_the_tool_exits_is_read_whole() {
        // A tool that exits at its deadline: what it wrote is still on its way through the pipe.
        let (reader, mut writer) = std::io::pipe().expect("a pipe");
        let kept = drain(reader);
        let late = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            writer.write_all(b"secret\n").expect("write");
        });
        assert_eq!(kept.text(AFTER_EXIT), "secret\n");
        late.join().expect("writer");
    }

    #[test]
    fn a_process_left_holding_the_output_does_not_hold_the_caller_past_the_deadline() {
        let began = Instant::now();
        let out = run("sh", Command::new("/bin/sh").args(["-c", "echo hi; sleep 5 &"]), None, Duration::from_secs(1))
            .expect("runs");
        assert_eq!(out.stdout, "hi\n");
        assert!(began.elapsed() < Duration::from_secs(4), "{:?}", began.elapsed());
    }
}
