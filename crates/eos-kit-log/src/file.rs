//! One log file: lines are queued without waiting and written, scrubbed, by a thread of
//! its own, which rotates the file by size and keeps a fixed number of older ones.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};

use crate::scrub::Scrubber;
use crate::time::utc_now;

/// How big a log may grow and how much it may hold back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// A file past this is rotated: `x.log` → `x.log.1` → … → `x.log.<keep>`.
    pub max_bytes: u64,
    /// How many rotated files are kept beside the live one.
    pub keep: usize,
    /// Lines waiting for the writer; when full, a line is dropped and counted.
    pub queue: usize,
    /// A longer line is cut to this many bytes.
    pub max_line: usize,
}

impl Limits {
    /// The core's log: at most 4 × 4 MiB on disk, 2048 lines (≤ 8 MiB) waiting.
    pub const CORE: Limits = Limits { max_bytes: 4 << 20, keep: 3, queue: 2048, max_line: 4096 };
    /// The shell's log: at most 3 × 1 MiB on disk, 256 lines waiting.
    pub const SHELL: Limits = Limits { max_bytes: 1 << 20, keep: 2, queue: 256, max_line: 2048 };

    /// The most the files of one log take on disk (a line may pass the size before rotation).
    pub fn disk_cap(&self) -> u64 {
        (self.max_bytes + self.max_line as u64) * (self.keep as u64 + 1)
    }
}

enum Msg {
    Line(Vec<u8>),
    Flush(Sender<()>),
}

/// A log file written from any thread without waiting. Cloning shares the file.
#[derive(Clone, Debug)]
pub struct LogFile {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    tx: Sender<Msg>,
    dropped: Arc<AtomicU64>,
    dropped_total: AtomicU64,
    path: PathBuf,
}

impl LogFile {
    /// Opens (creates) `<dir>/<name>` with its writer thread. Never fails: a log that
    /// cannot be written loses its lines and nothing else.
    pub fn open(dir: &Path, name: &str, limits: Limits, scrubber: Scrubber) -> LogFile {
        Self::open_gated(dir, name, limits, scrubber, None)
    }

    /// `gate`: the writer starts once it is answered or dropped (tests hold the writer back).
    fn open_gated(dir: &Path, name: &str, limits: Limits, scrubber: Scrubber, gate: Option<Receiver<()>>) -> LogFile {
        let (tx, rx) = bounded(limits.queue.max(1));
        let dropped = Arc::new(AtomicU64::new(0));
        let path = dir.join(name);
        let writer = Writer {
            dir: dir.to_owned(),
            name: name.to_owned(),
            limits,
            scrubber,
            out: None,
            size: 0,
            retry_at: None,
            dropped: dropped.clone(),
        };
        let thread = std::thread::Builder::new()
            .name(format!("eos-log-{}", name.split('.').next().unwrap_or("file")))
            .spawn(move || {
                if let Some(gate) = gate {
                    let _ = gate.recv();
                }
                writer.run(rx)
            });
        // Without its thread the receiver is gone, and every line counts as dropped.
        drop(thread);
        LogFile { inner: Arc::new(Inner { tx, dropped, dropped_total: AtomicU64::new(0), path }) }
    }

    /// Queues one line (it should end with `\n`). Never waits: when the queue is full the
    /// line is dropped and counted; `false` then.
    pub fn write(&self, line: Vec<u8>) -> bool {
        match self.inner.tx.try_send(Msg::Line(line)) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                self.inner.dropped_total.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Lines dropped since the file was opened.
    pub fn dropped(&self) -> u64 {
        self.inner.dropped_total.load(Ordering::Relaxed)
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// Waits up to `wait` until what was queued before is on disk; `false` when it was not.
    pub fn flush(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        let (ack, done) = bounded(1);
        if self.inner.tx.send_timeout(Msg::Flush(ack), wait).is_err() {
            return false;
        }
        done.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_ok()
    }
}

struct Writer {
    dir: PathBuf,
    name: String,
    limits: Limits,
    scrubber: Scrubber,
    out: Option<BufWriter<File>>,
    size: u64,
    /// After a failed open, the next try waits until then.
    retry_at: Option<Instant>,
    dropped: Arc<AtomicU64>,
}

const RETRY: Duration = Duration::from_secs(5);

impl Writer {
    fn run(mut self, rx: Receiver<Msg>) {
        self.reopen();
        while let Ok(first) = rx.recv() {
            let mut acks = Vec::new();
            let mut next = Some(first);
            while let Some(msg) = next {
                match msg {
                    Msg::Line(line) => self.line(&line),
                    Msg::Flush(ack) => acks.push(ack),
                }
                next = rx.try_recv().ok();
            }
            let lost = self.dropped.swap(0, Ordering::Relaxed);
            if lost > 0 {
                let note = format!("{} WARN eos::log: {lost} line(s) dropped: the log could not keep up\n", utc_now());
                self.line(note.as_bytes());
            }
            if let Some(out) = &mut self.out
                && out.flush().is_err()
            {
                self.out = None;
            }
            for ack in acks {
                let _ = ack.try_send(());
            }
        }
        if let Some(out) = &mut self.out {
            let _ = out.flush();
        }
    }

    fn path(&self, n: usize) -> PathBuf {
        if n == 0 { self.dir.join(&self.name) } else { self.dir.join(format!("{}.{n}", self.name)) }
    }

    fn reopen(&mut self) {
        if self.retry_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        let _ = std::fs::create_dir_all(&self.dir);
        match OpenOptions::new().create(true).append(true).open(self.path(0)) {
            Ok(file) => {
                self.size = file.metadata().map_or(0, |m| m.len());
                self.out = Some(BufWriter::with_capacity(16 << 10, file));
                self.retry_at = None;
                if self.size >= self.limits.max_bytes {
                    self.rotate();
                }
            }
            Err(_) => {
                self.out = None;
                self.retry_at = Some(Instant::now() + RETRY);
            }
        }
    }

    /// `x.log.<keep-1>` → `x.log.<keep>`, …, `x.log` → `x.log.1`, then a fresh `x.log`.
    fn rotate(&mut self) {
        if let Some(mut out) = self.out.take() {
            let _ = out.flush();
        }
        if self.limits.keep == 0 {
            let _ = std::fs::remove_file(self.path(0));
        } else {
            for n in (1..self.limits.keep).rev() {
                let _ = std::fs::rename(self.path(n), self.path(n + 1));
            }
            let _ = std::fs::rename(self.path(0), self.path(1));
        }
        match OpenOptions::new().create(true).append(true).open(self.path(0)) {
            Ok(file) => {
                self.size = 0;
                self.out = Some(BufWriter::with_capacity(16 << 10, file));
            }
            Err(_) => self.retry_at = Some(Instant::now() + RETRY),
        }
    }

    fn line(&mut self, raw: &[u8]) {
        if self.out.is_none() {
            self.reopen();
            if self.out.is_none() {
                return;
            }
        }
        let text = String::from_utf8_lossy(raw);
        let text = text.strip_suffix('\n').unwrap_or(&text);
        let mut clean = self.scrubber.scrub(text).into_owned();
        if clean.len() > self.limits.max_line {
            let mut cut = self.limits.max_line.saturating_sub(" […]".len());
            while !clean.is_char_boundary(cut) {
                cut -= 1;
            }
            clean.truncate(cut);
            clean.push_str(" […]");
        }
        clean.push('\n');
        if self.size + clean.len() as u64 > self.limits.max_bytes && self.size > 0 {
            self.rotate();
        }
        let Some(out) = &mut self.out else { return };
        if out.write_all(clean.as_bytes()).is_ok() {
            self.size += clean.len() as u64;
        } else {
            self.out = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(dir: &Path) -> Vec<(String, u64)> {
        let mut all: Vec<_> = std::fs::read_dir(dir)
            .expect("the folder")
            .filter_map(|e| e.ok())
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().map_or(0, |m| m.len())))
            .collect();
        all.sort();
        all
    }

    #[test]
    fn rotates_by_size_and_keeps_a_fixed_number_of_files() {
        let dir = tempfile::tempdir().expect("a folder");
        let limits = Limits { max_bytes: 1000, keep: 2, queue: 10_000, max_line: 200 };
        let log = LogFile::open(dir.path(), "core.log", limits, Scrubber::new(None));
        for n in 0..1000 {
            assert!(log.write(format!("line {n:05} {}\n", "x".repeat(40)).into_bytes()));
        }
        assert!(log.flush(Duration::from_secs(5)));
        let found = files(dir.path());
        let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["core.log", "core.log.1", "core.log.2"], "two older files are kept, no more");
        let total: u64 = found.iter().map(|(_, len)| len).sum();
        assert!(total <= limits.disk_cap(), "{total} bytes on disk");
        for (name, len) in &found {
            assert!(*len <= limits.max_bytes, "{name} is {len} bytes");
        }
        let newest = std::fs::read_to_string(dir.path().join("core.log")).expect("reads");
        assert!(newest.trim_end().ends_with(&format!("line 00999 {}", "x".repeat(40))), "the newest line is last");
    }

    #[test]
    fn a_log_already_too_big_is_rotated_when_opened() {
        let dir = tempfile::tempdir().expect("a folder");
        std::fs::write(dir.path().join("shell.log"), "y".repeat(5000)).expect("writes");
        let limits = Limits { max_bytes: 1000, keep: 1, queue: 16, max_line: 200 };
        let log = LogFile::open(dir.path(), "shell.log", limits, Scrubber::new(None));
        log.write(b"fresh\n".to_vec());
        assert!(log.flush(Duration::from_secs(5)));
        assert_eq!(std::fs::read_to_string(dir.path().join("shell.log")).expect("reads"), "fresh\n");
        assert_eq!(std::fs::metadata(dir.path().join("shell.log.1")).expect("kept").len(), 5000);
    }

    #[test]
    fn long_lines_are_cut() {
        let dir = tempfile::tempdir().expect("a folder");
        let limits = Limits { max_bytes: 10_000, keep: 1, queue: 16, max_line: 100 };
        let log = LogFile::open(dir.path(), "core.log", limits, Scrubber::new(None));
        log.write(format!("{}\n", "é".repeat(500)).into_bytes());
        assert!(log.flush(Duration::from_secs(5)));
        let text = std::fs::read_to_string(dir.path().join("core.log")).expect("reads");
        assert!(text.len() <= 101 && text.ends_with(" […]\n"), "{} bytes", text.len());
    }

    #[test]
    fn a_full_queue_drops_and_counts_and_never_waits() {
        // The writer is held back (as by a stalled disk): the queue fills and stays bounded.
        let dir = tempfile::tempdir().expect("a folder");
        let (hold, gate) = bounded::<()>(0);
        let limits = Limits { max_bytes: 1000, keep: 1, queue: 4, max_line: 100 };
        let log = LogFile::open_gated(dir.path(), "core.log", limits, Scrubber::new(None), Some(gate));
        let began = Instant::now();
        let sent = (0..100_000).filter(|_| log.write(b"a line\n".to_vec())).count();
        assert!(began.elapsed() < Duration::from_secs(2), "writing never waits: {:?}", began.elapsed());
        assert_eq!(log.dropped() as usize, 100_000 - sent, "every line not queued is counted");
        assert_eq!(sent, 4, "the queue holds four lines");
        drop(hold);
        assert!(log.flush(Duration::from_secs(5)));
        let text = std::fs::read_to_string(dir.path().join("core.log")).expect("reads");
        assert_eq!(text.matches("a line").count(), 4);
        assert!(text.contains("99996 line(s) dropped"), "{text}");
    }

    #[test]
    fn a_log_that_cannot_be_written_costs_nothing_but_its_lines() {
        let dir = tempfile::tempdir().expect("a folder");
        let blocker = dir.path().join("not-a-folder");
        std::fs::write(&blocker, "").expect("a file");
        let log = LogFile::open(&blocker.join("logs"), "core.log", Limits::SHELL, Scrubber::new(None));
        for _ in 0..1000 {
            log.write(b"a line\n".to_vec());
        }
        assert!(log.flush(Duration::from_secs(5)), "the writer still answers");
    }

    #[test]
    fn overflow_is_noted_in_the_file_once_there_is_room() {
        let dir = tempfile::tempdir().expect("a folder");
        let limits = Limits { max_bytes: 1 << 20, keep: 1, queue: 2, max_line: 100 };
        let (hold, gate) = bounded::<()>(0);
        let log = LogFile::open_gated(dir.path(), "core.log", limits, Scrubber::new(None), Some(gate));
        for _ in 0..10_000 {
            log.write(b"burst\n".to_vec());
        }
        drop(hold);
        assert!(log.flush(Duration::from_secs(5)));
        let dropped = log.dropped();
        let text = std::fs::read_to_string(dir.path().join("core.log")).expect("reads");
        let noted: u64 =
            text.lines().filter_map(|l| l.split("eos::log: ").nth(1)?.split(' ').next()?.parse::<u64>().ok()).sum();
        assert!(dropped > 0, "a queue of two overflows in a burst");
        assert_eq!(noted, dropped, "each dropped line is accounted for in the file");
    }
}
