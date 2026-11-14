//! Claude Code's transcript files, read while Claude appends to them.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use eos_core::terminal::{ClaudeTranscripts, TranscriptFile};
use eos_domain::claude_transcript::{TranscriptRows, TranscriptView, encode_cwd};

/// The last bytes before the read offset, compared on every read: a rewrite
/// in place that leaves the file bigger shows up here unless it kept them.
const GUARD_BYTES: usize = 4096;

/// Transcripts where Claude Code keeps them:
/// `<home>/.claude/projects/<the folder's real path, encoded>/<session>.jsonl`.
#[derive(Debug, Clone)]
pub struct ClaudeTranscriptFiles {
    home: PathBuf,
}

impl ClaudeTranscriptFiles {
    /// `home` is the user's home folder.
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    pub fn path(&self, cwd: &str, session_id: &str) -> PathBuf {
        // The encoding needs the real path; the raw one stands in when the
        // folder cannot be resolved.
        let dir = std::fs::canonicalize(cwd).map_or_else(|_| cwd.to_owned(), |p| p.to_string_lossy().into_owned());
        self.home.join(".claude").join("projects").join(encode_cwd(&dir)).join(format!("{session_id}.jsonl"))
    }
}

impl ClaudeTranscripts for ClaudeTranscriptFiles {
    fn open(&self, cwd: &str, session_id: &str) -> Box<dyn TranscriptFile> {
        Box::new(TranscriptReader::new(self.path(cwd, session_id), false))
    }
}

/// What identifies the file's state at a read.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Seen {
    file: u64,
    size: u64,
    modified: SystemTime,
}

#[cfg(unix)]
fn file_id(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

#[cfg(not(unix))]
fn file_id(_meta: &std::fs::Metadata) -> u64 {
    0
}

/// A transcript read as it grows: a read parses only the lines completed
/// since the one before. A file that shrank below what was read, was
/// replaced, went back in time or changed before the read offset is read
/// again from the start.
#[derive(Debug)]
pub struct TranscriptReader {
    path: PathBuf,
    sidechain: bool,
    rows: TranscriptRows,
    /// Just past the last whole line.
    offset: u64,
    guard: Vec<u8>,
    seen: Option<Seen>,
    view: Option<TranscriptView>,
}

impl TranscriptReader {
    /// `sidechain` reads a subagent's own transcript.
    pub fn new(path: impl Into<PathBuf>, sidechain: bool) -> Self {
        Self {
            path: path.into(),
            sidechain,
            rows: TranscriptRows::new(sidechain),
            offset: 0,
            guard: Vec::new(),
            seen: None,
            view: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn reset(&mut self) {
        self.rows = TranscriptRows::new(self.sidechain);
        self.offset = 0;
        self.guard.clear();
    }
}

fn read_range(file: &mut File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    file.seek(SeekFrom::Start(start))?;
    file.take(end.saturating_sub(start)).read_to_end(&mut buf)?;
    Ok(buf)
}

impl TranscriptFile for TranscriptReader {
    fn read(&mut self) -> Option<TranscriptView> {
        let mut file = File::open(&self.path).ok()?;
        let meta = file.metadata().ok()?;
        let now = Seen { file: file_id(&meta), size: meta.len(), modified: meta.modified().ok()? };
        let before = self.seen.take();
        if before == Some(now) {
            self.seen = before;
            return self.view.clone();
        }
        if before.is_none_or(|b| b.file != now.file || now.size < self.offset || now.modified < b.modified) {
            self.reset();
        }
        let mut buf = read_range(&mut file, self.offset - self.guard.len() as u64, now.size).ok()?;
        if buf.get(..self.guard.len()) != Some(&self.guard) {
            self.reset();
            buf = read_range(&mut file, 0, now.size).ok()?;
        }
        let from = self.guard.len();
        let end = buf.iter().rposition(|b| *b == b'\n').map_or(0, |at| at + 1).max(from);
        let lines = String::from_utf8_lossy(&buf[from..end]).into_owned();
        let tail = String::from_utf8_lossy(&buf[end..]).into_owned();
        self.offset += (end - from) as u64;
        self.guard = buf[end.saturating_sub(GUARD_BYTES)..end].to_vec();

        self.rows.add(&lines);
        self.view = Some(self.rows.view(&tail));
        self.seen = Some(now);
        self.view.clone()
    }

    fn stamp(&self) -> Option<(u64, i64)> {
        let meta = std::fs::metadata(&self.path).ok()?;
        let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some((meta.len(), i64::try_from(modified.as_millis()).unwrap_or(i64::MAX)))
    }
}
