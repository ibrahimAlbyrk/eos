//! `portable-pty` on macOS driving a real shell: spawn, type, run a full-screen
//! program, resize, exit — and what the session's bytes look like.
//!
//!   pty-demo <capture.bin>     writes the raw output of session A (80x24) for the mirror comparison
//!
//! Prints a JSON summary: spawn time, whether a resize reached the shell, the
//! exit code, and how long after the child's exit the reader saw end of file.

use std::{
    io::{Read, Write},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use anyhow::Context;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::json;

struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    seen: Vec<u8>,
    spawn_ms: f64,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

impl Session {
    fn start(cols: u16, rows: u16) -> anyhow::Result<Self> {
        let started = Instant::now();
        let pair = native_pty_system().openpty(size(cols, rows))?;
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.env_clear();
        cmd.env("TERM", "xterm-256color");
        cmd.env("PS1", "$ ");
        cmd.env("PATH", "/usr/bin:/bin");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LESS", "");
        cmd.cwd("/tmp");
        let child = pair.slave.spawn_command(cmd)?;
        // The parent must let go of the slave side, or end of file never comes.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (tx, output) = mpsc::channel();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self {
            master: pair.master,
            child,
            writer,
            output,
            seen: Vec::new(),
            spawn_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    fn send(&mut self, text: &str) -> anyhow::Result<()> {
        self.writer.write_all(text.as_bytes())?;
        self.writer.flush()?;
        Ok(())
    }

    /// Reads until `needle` shows up in the output after `from`.
    fn wait_for(&mut self, needle: &str, from: usize) -> anyhow::Result<usize> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(at) = find(&self.seen[from..], needle.as_bytes()) {
                return Ok(from + at + needle.len());
            }
            let left =
                deadline.checked_duration_since(Instant::now()).context(format!("timed out waiting for {needle:?}"))?;
            let chunk = self.output.recv_timeout(left).context(format!("output ended before {needle:?}"))?;
            self.seen.extend_from_slice(&chunk);
        }
    }

    /// Everything until the reader thread reports end of file.
    fn drain(&mut self) -> Duration {
        let started = Instant::now();
        while let Ok(chunk) = self.output.recv_timeout(Duration::from_secs(10)) {
            self.seen.extend_from_slice(&chunk);
        }
        started.elapsed()
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn main() -> anyhow::Result<()> {
    let capture = std::env::args().nth(1).context("usage: pty-demo <capture.bin>")?;

    // ---- session A: colors, wide text, a full-screen pager, exit code ----
    let mut a = Session::start(80, 24)?;
    let mut at = a.wait_for("$ ", 0)?;
    a.send("printf '\\033[1;32mgreen bold\\033[0m \\033[38;5;208morange\\033[0m 日本語 😀\\n'\n")?;
    at = a.wait_for("😀\r\n", at)?;
    a.send("i=0; while [ $i -lt 60 ]; do echo \"row $i\"; i=$((i+1)); done > /tmp/eos-spike-pty.txt; echo made\n")?;
    at = a.wait_for("made\r\n", at)?;
    a.send("less /tmp/eos-spike-pty.txt\n")?;
    at = a.wait_for("row 22", at)?; // the pager has drawn its first screen (alternate screen)
    a.send(" ")?; // page down
    at = a.wait_for("row 45", at)?;
    let in_pager = a.seen.clone();
    a.send("q")?;
    at = a.wait_for("$ ", at)?;
    a.send("rm /tmp/eos-spike-pty.txt; exit 7\n")?;
    let exited = Instant::now();
    let status = a.child.wait()?;
    let wait_ms = exited.elapsed().as_secs_f64() * 1000.0;
    let eof = a.drain();
    let _ = at;
    std::fs::write(&capture, &a.seen)?;
    std::fs::write(format!("{capture}.in-pager"), &in_pager)?;

    // ---- session B: resize reaches the shell; kill ends a busy child ----
    let mut b = Session::start(80, 24)?;
    let mut at = b.wait_for("$ ", 0)?;
    b.send("stty size\n")?;
    at = b.wait_for("24 80", at)?;
    b.master.resize(size(100, 30))?;
    b.send("stty size\n")?;
    let resized = b.wait_for("30 100", at).is_ok();
    b.send("sleep 600\n")?;
    thread::sleep(Duration::from_millis(200));
    let kill_started = Instant::now();
    b.child.kill()?;
    let killed = b.child.wait()?;
    let kill_ms = kill_started.elapsed().as_secs_f64() * 1000.0;
    let eof_after_kill = b.drain();

    println!(
        "{}",
        json!({
            "portable-pty": "0.9.0",
            "sessionA": {
                "spawnMs": (a.spawn_ms * 10.0).round() / 10.0, "bytes": a.seen.len(),
                "exitCode": status.exit_code(), "waitAfterExitMs": wait_ms.round(),
                "eofAfterExitMs": (eof.as_secs_f64() * 1000.0).round(),
                "usedAlternateScreen": find(&a.seen, b"\x1b[?1049h").is_some(),
            },
            "sessionB": {
                "spawnMs": (b.spawn_ms * 10.0).round() / 10.0, "resizeReachedShell": resized,
                "killMs": kill_ms.round(), "exitAfterKill": format!("{killed:?}"),
                "eofAfterKillMs": (eof_after_kill.as_secs_f64() * 1000.0).round(),
            },
        })
    );
    Ok(())
}
