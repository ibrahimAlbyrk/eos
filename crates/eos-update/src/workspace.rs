//! `~/.eos/updates` — regenerable. Fetched ranges live under
//! `downloads/<version>/` (checked chunk by chunk before they are kept); the new
//! bundle is built under `staged/<version>/` on the same volume as the installed
//! app, so unchanged files are clone copies (instant, no extra disk) and the
//! final swap is a rename; `staged.json` says which version is ready.
//!
//! Building a bundle never touches the installed one, and the result is
//! scanned again and compared with the manifest entry by entry before it counts.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use eos_contracts::update::{PackSpan, UpdateEntry, UpdateEntryFile, UpdateManifest, UpdateNotice, update_files};
use eos_contracts::validate;
use eos_core::BoxFuture;
use eos_core::net::updates::{StageRequest, SwapResult, UpdateWorkspace};
use eos_domain::update::{
    CHUNK_MAX, FetchRange, FilePart, FileStep, StagedUpdate, UpdateError, chunks_within, entry_path,
};
use eos_platform::ThreadClass;
use sha2::{Digest, Sha256};

use crate::fsx;
use crate::scan::{ScannedEntry, hex, scan_bundle, sha256_hex};

const COPY_SLICE: usize = 4 * 1024 * 1024;
const LAST_VERSION: &str = "last-version";

#[derive(Debug, Clone)]
pub struct FsUpdateWorkspace {
    dir: PathBuf,
    /// Whether files keep permission bits here (not on Windows).
    file_modes: bool,
}

impl FsUpdateWorkspace {
    pub fn new(dir: impl Into<PathBuf>, file_modes: bool) -> Self {
        Self { dir: dir.into(), file_modes }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn range_path(&self, version: &str, range: &FetchRange) -> PathBuf {
        self.dir.join("downloads").join(version).join(format!("{}-{}-{}.zst", range.pack, range.offset, range.length))
    }

    fn staged_record(&self) -> PathBuf {
        self.dir.join("staged.json")
    }

    fn put_range_blocking(
        &self,
        version: &str,
        range: &FetchRange,
        bytes: &[u8],
        manifest: &UpdateManifest,
    ) -> Result<(), UpdateError> {
        for i in chunks_within(manifest, range) {
            let c = &manifest.chunks[i];
            let frame = usize::try_from(c.offset - range.offset)
                .ok()
                .zip(usize::try_from(c.zsize).ok())
                .and_then(|(at, len)| bytes.get(at..at + len));
            if !frame.is_some_and(|frame| chunk_matches(frame, &c.id, c.size)) {
                return Err(UpdateError::corrupt(format!("chunk {} came down damaged", &c.id[..c.id.len().min(12)])));
            }
        }
        let path = self.range_path(version, range);
        let write = || -> io::Result<()> {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fsx::write_then_rename(&path, ".part", bytes)
        };
        write().map_err(|e| UpdateError::disk(format!("keeping fetched bytes failed: {e}")))
    }

    /// Clones and the final rename need the installed app's volume.
    fn staging_base(&self, version: &str, installed_root: &Path) -> io::Result<PathBuf> {
        fs::create_dir_all(&self.dir)?;
        let app_dir = installed_root.parent().unwrap_or(installed_root);
        Ok(if fsx::same_volume(&self.dir, app_dir)? {
            self.dir.join("staged").join(version)
        } else {
            app_dir.join(format!(".eos-update-{version}"))
        })
    }

    fn stage_blocking(&self, request: &StageRequest) -> Result<String, UpdateError> {
        let StageRequest { version, manifest, plan, installed_root } = request;
        let installed_root = Path::new(installed_root);
        let disk = |e: io::Error| UpdateError::disk(format!("building the new version failed: {e}"));
        let base = self.staging_base(version, installed_root).map_err(disk)?;
        let name = installed_root.file_name().ok_or_else(|| UpdateError::disk("the installed app has no name"))?;
        let root = base.join(name);
        fsx::remove_all(&base).map_err(disk)?;
        fs::create_dir_all(&root).map_err(disk)?;

        let steps: HashMap<&str, &FileStep> = plan.files.iter().map(|s| (s.path(), s)).collect();
        let mut frames =
            FrameReader { workspace: self, version, ranges: &plan.ranges, manifest, files: HashMap::new() };
        for entry in &manifest.entries {
            let dst = root.join(entry_path(entry));
            match entry {
                UpdateEntry::Dir(_) => fs::create_dir_all(&dst).map_err(disk)?,
                UpdateEntry::File(file) => {
                    self.write_file(file, steps.get(file.path.as_str()).copied(), &dst, installed_root, &mut frames)?;
                }
                UpdateEntry::Link(_) => {}
            }
        }
        for entry in &manifest.entries {
            if let UpdateEntry::Link(link) = entry {
                fsx::symlink(&link.target, &root.join(&link.path)).map_err(disk)?;
            }
        }
        if self.file_modes {
            // Deepest first: a folder may lose its write bit only after it is filled.
            for entry in manifest.entries.iter().rev() {
                if let UpdateEntry::Dir(dir) = entry {
                    fsx::set_mode(&root.join(&dir.path), dir.mode).map_err(disk)?;
                }
            }
            fsx::set_mode(&root, 0o755).map_err(disk)?;
        }
        drop(frames);

        let built = scan_bundle(&root, false).map_err(disk)?;
        if let Some(problem) = tree_mismatch(&manifest.entries, &built, self.file_modes) {
            return Err(UpdateError::corrupt(format!("the new version does not match its manifest: {problem}")));
        }
        root.into_os_string().into_string().map_err(|_| UpdateError::disk("the staging path is not text"))
    }

    fn write_file(
        &self,
        entry: &UpdateEntryFile,
        step: Option<&FileStep>,
        dst: &Path,
        installed_root: &Path,
        frames: &mut FrameReader<'_>,
    ) -> Result<(), UpdateError> {
        let disk = |e: io::Error| UpdateError::disk(format!("building the new version failed: {e}"));
        let Some(step) = step else { return Err(UpdateError::bad_release(format!("{} has no plan", entry.path))) };
        if let FileStep::Copy { source, .. } = step {
            eos_platform::clone_copy(&installed_root.join(source), dst).map_err(disk)?;
        } else {
            let mut out = HashingWriter { file: File::create(dst).map_err(disk)?, hash: Sha256::new(), size: 0 };
            match step {
                FileStep::Whole { span, .. } => frames.stream_whole(span, &mut out)?,
                FileStep::Assemble { parts, .. } => {
                    for part in parts {
                        write_part(part, installed_root, frames, &mut out)?;
                    }
                }
                FileStep::Copy { .. } => {}
            }
            if out.size != entry.size || hex(&out.hash.finalize()) != entry.sha256 {
                return Err(UpdateError::corrupt(format!("{} did not come out as the release has it", entry.path)));
            }
        }
        if self.file_modes {
            fsx::set_mode(dst, entry.mode).map_err(disk)?;
        }
        Ok(())
    }

    fn clear_blocking(&self, keep: Option<&str>) -> io::Result<()> {
        fsx::remove_all(&self.staged_record())?;
        fsx::remove_all(&self.dir.join("staged"))?;
        let downloads = self.dir.join("downloads");
        let Some(keep) = keep else { return fsx::remove_all(&downloads) };
        let Ok(listing) = fs::read_dir(&downloads) else { return Ok(()) };
        for entry in listing {
            let entry = entry?;
            if entry.file_name() != keep {
                fsx::remove_all(&entry.path())?;
            }
        }
        Ok(())
    }

    fn staged_blocking(&self) -> Option<StagedUpdate> {
        let record: StagedUpdate = serde_json::from_slice(&fs::read(self.staged_record()).ok()?).ok()?;
        fs::metadata(&record.path).is_ok_and(|m| m.is_dir()).then_some(record)
    }

    fn result_blocking(&self) -> Option<SwapResult> {
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(self.dir.join(update_files::RESULT)).ok()?).ok()?;
        let notice: UpdateNotice = validate::parse(&raw).ok()?;
        Some(SwapResult { notice, dismissed: raw.get("dismissed") == Some(&serde_json::Value::Bool(true)) })
    }

    fn dismiss_result_blocking(&self) -> io::Result<()> {
        let Some(current) = self.result_blocking() else { return Ok(()) };
        let mut record = serde_json::to_value(&current.notice).map_err(io::Error::other)?;
        if let Some(fields) = record.as_object_mut() {
            fields.insert("dismissed".to_owned(), serde_json::Value::Bool(true));
        }
        fsx::write_then_rename(&self.dir.join(update_files::RESULT), ".tmp", record.to_string().as_bytes())
    }
}

struct HashingWriter {
    file: File,
    hash: Sha256,
    size: i64,
}

impl Write for HashingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.file.write_all(bytes)?;
        self.hash.update(bytes);
        self.size += bytes.len() as i64;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn write_part(
    part: &FilePart,
    installed_root: &Path,
    frames: &mut FrameReader<'_>,
    out: &mut HashingWriter,
) -> Result<(), UpdateError> {
    let disk = |e: io::Error| UpdateError::disk(format!("building the new version failed: {e}"));
    match part {
        FilePart::Pack { chunk } => out.write_all(&frames.chunk(*chunk)?).map_err(disk),
        FilePart::Disk { path, offset, size } => {
            let mut src = File::open(installed_root.join(path)).map_err(disk)?;
            src.seek(SeekFrom::Start(u64::try_from(*offset).unwrap_or(0))).map_err(disk)?;
            let size = u64::try_from(*size).unwrap_or(0);
            let copied = io::copy(&mut src.take(size), out).map_err(disk)?;
            if copied != size {
                return Err(UpdateError::disk(format!("{path} is shorter than when it was indexed")));
            }
            Ok(())
        }
    }
}

/// Reads frames out of the fetched ranges that hold them.
struct FrameReader<'a> {
    workspace: &'a FsUpdateWorkspace,
    version: &'a str,
    ranges: &'a [FetchRange],
    manifest: &'a UpdateManifest,
    /// One open file per fetched range, for the length of one staging run.
    files: HashMap<PathBuf, File>,
}

impl FrameReader<'_> {
    fn chunk(&mut self, index: usize) -> Result<Vec<u8>, UpdateError> {
        let c =
            self.manifest.chunks.get(index).ok_or_else(|| UpdateError::corrupt("a needed chunk was never fetched"))?;
        let (path, at) = self.locate(c.pack, c.offset, c.zsize)?;
        let mut frame = vec![0u8; usize::try_from(c.zsize).unwrap_or(0)];
        let file = self.file(path)?;
        let read = file.seek(SeekFrom::Start(at)).and_then(|_| file.read_exact(&mut frame));
        if read.is_err() {
            return Err(UpdateError::corrupt("a fetched range is shorter than its chunks"));
        }
        zstd::bulk::decompress(&frame, CHUNK_MAX).map_err(|_| UpdateError::corrupt("a fetched chunk does not unpack"))
    }

    fn stream_whole(&mut self, span: &PackSpan, out: &mut HashingWriter) -> Result<(), UpdateError> {
        let (path, at) = self.locate(span.pack, span.offset, span.zsize)?;
        let frame_len = u64::try_from(span.zsize).unwrap_or(0);
        let file = self.file(path)?;
        let mut copy = || -> io::Result<()> {
            file.seek(SeekFrom::Start(at))?;
            let mut decoder = zstd::stream::read::Decoder::new((&mut *file).take(frame_len))?.single_frame();
            let mut buf = vec![0u8; COPY_SLICE.min(1024 * 1024)];
            loop {
                let read = decoder.read(&mut buf)?;
                if read == 0 {
                    return Ok(());
                }
                out.write_all(&buf[..read])?;
            }
        };
        copy().map_err(|_| UpdateError::corrupt("a whole-file frame does not unpack"))
    }

    fn locate(&self, pack: i64, offset: i64, zsize: i64) -> Result<(PathBuf, u64), UpdateError> {
        let range = self
            .ranges
            .iter()
            .find(|r| r.holds(pack, offset, zsize))
            .ok_or_else(|| UpdateError::corrupt("a needed chunk was never fetched"))?;
        Ok((self.workspace.range_path(self.version, range), u64::try_from(offset - range.offset).unwrap_or(0)))
    }

    fn file(&mut self, path: PathBuf) -> Result<&mut File, UpdateError> {
        use std::collections::hash_map::Entry;
        match self.files.entry(path) {
            Entry::Occupied(open) => Ok(open.into_mut()),
            Entry::Vacant(slot) => {
                let file =
                    File::open(slot.key()).map_err(|_| UpdateError::corrupt("a needed chunk was never fetched"))?;
                Ok(slot.insert(file))
            }
        }
    }
}

fn chunk_matches(frame: &[u8], id: &str, size: i64) -> bool {
    zstd::bulk::decompress(frame, CHUNK_MAX).is_ok_and(|bytes| bytes.len() as i64 == size && sha256_hex(&bytes) == id)
}

/// The first way a built tree differs from what the manifest lists, if any.
pub fn tree_mismatch(expected: &[UpdateEntry], actual: &[ScannedEntry], modes: bool) -> Option<String> {
    if expected.len() != actual.len() {
        return Some(format!("{} entries instead of {}", actual.len(), expected.len()));
    }
    let built: HashMap<&str, &ScannedEntry> = actual.iter().map(|a| (a.path(), a)).collect();
    for want in expected {
        let path = entry_path(want);
        match (want, built.get(path)) {
            (UpdateEntry::Link(w), Some(ScannedEntry::Link { target, .. })) => {
                if w.target != *target {
                    return Some(format!("{path} links elsewhere"));
                }
            }
            (UpdateEntry::Dir(w), Some(ScannedEntry::Dir { mode, .. })) => {
                if modes && w.mode != *mode {
                    return Some(format!("{path} has mode {mode:o}"));
                }
            }
            (UpdateEntry::File(w), Some(ScannedEntry::File { mode, size, sha256, .. })) => {
                if (modes && w.mode != *mode) || w.size != *size || w.sha256 != *sha256 {
                    return Some(format!("{path} differs"));
                }
            }
            _ => return Some(format!("{path} is missing")),
        }
    }
    None
}

/// Runs disk work off the async threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, UpdateError> {
    tokio::task::spawn_blocking(work).await.map_err(|e| UpdateError::disk(e.to_string()))
}

/// [`blocking`] for unpacking, hashing and writing a release: long work nobody waits on,
/// at the utility class so it never takes a CPU from the window or a request.
async fn background<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, UpdateError> {
    blocking(move || eos_platform::in_thread_class(ThreadClass::Utility, work)).await
}

impl UpdateWorkspace for FsUpdateWorkspace {
    fn has_range<'a>(&'a self, version: &'a str, range: FetchRange) -> BoxFuture<'a, bool> {
        let path = self.range_path(version, &range);
        Box::pin(async move {
            blocking(move || {
                fs::metadata(path).is_ok_and(|m| m.len() == u64::try_from(range.length).unwrap_or(u64::MAX))
            })
            .await
            .unwrap_or(false)
        })
    }

    fn put_range<'a>(
        &'a self,
        version: &'a str,
        range: FetchRange,
        bytes: Vec<u8>,
        manifest: Arc<UpdateManifest>,
    ) -> BoxFuture<'a, Result<(), UpdateError>> {
        let (this, version) = (self.clone(), version.to_owned());
        Box::pin(async move { background(move || this.put_range_blocking(&version, &range, &bytes, &manifest)).await? })
    }

    fn stage(&self, request: StageRequest) -> BoxFuture<'_, Result<String, UpdateError>> {
        let this = self.clone();
        Box::pin(async move { background(move || this.stage_blocking(&request)).await? })
    }

    fn staged(&self) -> BoxFuture<'_, Option<StagedUpdate>> {
        let this = self.clone();
        Box::pin(async move { blocking(move || this.staged_blocking()).await.ok().flatten() })
    }

    fn mark_staged<'a>(&'a self, update: &'a StagedUpdate) -> BoxFuture<'a, Result<(), UpdateError>> {
        let (this, record) = (self.clone(), serde_json::to_vec(update));
        Box::pin(async move {
            let record = record.map_err(|e| UpdateError::disk(e.to_string()))?;
            blocking(move || {
                fs::create_dir_all(&this.dir)?;
                fsx::write_then_rename(&this.staged_record(), ".tmp", &record)
            })
            .await?
            .map_err(|e| UpdateError::disk(format!("recording the staged version failed: {e}")))
        })
    }

    fn clear<'a>(&'a self, keep: Option<&'a str>) -> BoxFuture<'a, Result<(), UpdateError>> {
        let (this, keep) = (self.clone(), keep.map(str::to_owned));
        Box::pin(async move {
            blocking(move || this.clear_blocking(keep.as_deref()))
                .await?
                .map_err(|e| UpdateError::disk(format!("clearing the update folder failed: {e}")))
        })
    }

    fn last_version(&self) -> BoxFuture<'_, Option<String>> {
        let path = self.dir.join(LAST_VERSION);
        Box::pin(async move {
            let text = blocking(move || fs::read_to_string(path).unwrap_or_default()).await.unwrap_or_default();
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        })
    }

    fn set_last_version<'a>(&'a self, version: &'a str) -> BoxFuture<'a, Result<(), UpdateError>> {
        let (this, version) = (self.clone(), version.to_owned());
        Box::pin(async move {
            blocking(move || {
                fs::create_dir_all(&this.dir)?;
                fs::write(this.dir.join(LAST_VERSION), version)
            })
            .await?
            .map_err(|e| UpdateError::disk(format!("recording this version failed: {e}")))
        })
    }

    fn result(&self) -> BoxFuture<'_, Option<SwapResult>> {
        let this = self.clone();
        Box::pin(async move { blocking(move || this.result_blocking()).await.ok().flatten() })
    }

    fn dismiss_result(&self) -> BoxFuture<'_, Result<(), UpdateError>> {
        let this = self.clone();
        Box::pin(async move {
            blocking(move || this.dismiss_result_blocking())
                .await?
                .map_err(|e| UpdateError::disk(format!("recording the dismissal failed: {e}")))
        })
    }
}
