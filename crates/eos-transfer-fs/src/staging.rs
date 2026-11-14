//! Receiving a transfer: the staging folder, appending chunks, and placing
//! what was staged.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::os::unix::fs::{FileExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{
    ManifestItem, ManifestItemType, Num, TRANSFER_MAX_ITEMS, TransferCommitRequest, TransferCommitResult,
    TransferDecision, TransferErrorCode as Code, TransferExisting, TransferPlaced, TransferPrepareRequest,
    TransferPrepareResult,
};
use eos_core::Clock;
use eos_core::net::transfer::WriteAt;
use eos_domain::transfer::{TransferError, format_bytes, is_transfer_id, keep_both_name, rel_segments, root_of};
use eos_kit_fs::path::normalize;
use indexmap::IndexMap;
use rustix::fs::{AtFlags, CWD, Timespec, Timestamps};

use crate::Trash;
use crate::disk::{absolute, item_type, mtime_ms, names_in, refuse, text};

pub const STAGING_DIR: &str = ".eos-incoming";
/// A commit's answer is kept a while, so a retry after a lost response is a no-op.
const COMMIT_MEMORY_MS: i64 = 10 * 60_000;
/// Answers kept at most; the oldest goes first.
const COMMITS_KEPT: usize = 256;
/// Stagings held in memory at most; one that is dropped is read back from
/// its `manifest.json` when its transfer goes on.
const SESSIONS_KEPT: usize = 8;

/// The staging a prepare set up.
struct Session {
    dest_dir: PathBuf,
    stage: PathBuf,
    files_root: PathBuf,
    /// `files_root` with links resolved, as it was when the staging was set up.
    real_files_root: PathBuf,
    items: Vec<ManifestItem>,
    /// Each file by its path in the manifest.
    files: HashMap<String, Staged>,
}

/// A file of the manifest, as its staged copy must end up.
#[derive(Clone, Copy)]
struct Staged {
    size: u64,
    mode: u32,
    mtime_ms: f64,
}

/// A manifest mode as permission bits.
fn mode_of(item: &ManifestItem) -> u32 {
    u32::try_from(item.mode).unwrap_or(0o600) & 0o777
}

impl Session {
    fn open(dest_dir: PathBuf, stage: PathBuf, items: Vec<ManifestItem>) -> Result<Arc<Self>, TransferError> {
        let files_root = stage.join("files");
        let real_files_root =
            fs::canonicalize(&files_root).map_err(|_| refuse(Code::NotFound, "nothing is staged for this transfer"))?;
        let files = items
            .iter()
            .filter(|item| item.r#type == ManifestItemType::File)
            .map(|item| {
                let size = u64::try_from(item.size).unwrap_or(0);
                (item.rel.clone(), Staged { size, mode: mode_of(item), mtime_ms: item.mtime_ms.as_f64() })
            })
            .collect();
        Ok(Arc::new(Self { dest_dir, stage, files_root, real_files_root, items, files }))
    }

    /// The folder a staged file is written into must really be inside the
    /// staging: a link left there by an earlier, interrupted commit must not
    /// redirect it.
    fn assert_inside(&self, dir: &Path) -> Result<(), TransferError> {
        let real = fs::canonicalize(dir).map_err(|_| refuse(Code::BadPath, "that file's folder isn't staged"))?;
        if real.starts_with(&self.real_files_root) {
            Ok(())
        } else {
            Err(refuse(Code::BadPath, "that path leaves the staging folder"))
        }
    }

    /// Opens a staged file for writing, creating it; never through a link.
    fn open_staged(&self, path: &Path) -> Result<fs::File, TransferError> {
        self.assert_inside(path.parent().unwrap_or(&self.files_root))?;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(path)
            .map_err(TransferError::failed)
    }
}

#[derive(Default)]
struct Memory {
    /// Most recently used last.
    sessions: Vec<(String, Arc<Session>)>,
    /// Oldest first.
    committed: Vec<(String, i64, TransferCommitResult)>,
}

pub(crate) struct Disk {
    home: PathBuf,
    /// Each forbidden root as written and as it really is (`/var` → `/private/var`).
    forbidden: Vec<PathBuf>,
    trash: Trash,
    clock: Arc<dyn Clock>,
    memory: Mutex<Memory>,
}

fn valid_items(items: Vec<ManifestItem>) -> Result<Vec<ManifestItem>, TransferError> {
    if items.len() > TRANSFER_MAX_ITEMS as usize {
        return Err(refuse(Code::TooMany, "too many files in one transfer — zip them first"));
    }
    let mut seen = HashSet::with_capacity(items.len());
    for item in &items {
        if rel_segments(&item.rel).is_none() {
            return Err(refuse(Code::BadPath, format!("\"{}\" isn't a safe path", item.rel)));
        }
        if !seen.insert(item.rel.as_str()) {
            return Err(refuse(Code::BadPath, format!("\"{}\" appears twice", item.rel)));
        }
        if item.r#type == ManifestItemType::Link && item.target.is_none() {
            return Err(refuse(Code::BadPath, format!("link \"{}\" has no target", item.rel)));
        }
    }
    Ok(items)
}

/// The manifest a staging was prepared with; empty when there is none.
fn read_manifest(stage: &Path) -> Vec<ManifestItem> {
    fs::read(stage.join("manifest.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Vec<ManifestItem>>(&raw).ok())
        .and_then(|items| valid_items(items).ok())
        .unwrap_or_default()
}

/// What a commit already placed: picked item → the name it landed under
/// (`None`: skipped), in the order they landed.
fn read_progress(path: &Path) -> IndexMap<String, Option<String>> {
    fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<Vec<(String, Option<String>)>>(&raw).ok())
        .map(|pairs| pairs.into_iter().collect())
        .unwrap_or_default()
}

fn check_id(id: &str) -> Result<(), TransferError> {
    if is_transfer_id(id) { Ok(()) } else { Err(refuse(Code::BadPath, "that isn't a transfer id")) }
}

/// Removes whatever is at `path` (a link itself, never what it points at).
fn remove_any(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(_) => Ok(()),
    }
}

/// Access and modification time, both `mtime_ms`.
fn times(mtime_ms: f64) -> Timestamps {
    let seconds = mtime_ms / 1000.0;
    let whole = seconds.floor();
    let at = Timespec { tv_sec: whole as i64, tv_nsec: ((seconds - whole) * 1e9) as _ };
    Timestamps { last_access: at, last_modification: at }
}

/// Gives what is staged at `path` its mode and time, touching only what
/// differs: a file got both when its last chunk landed.
fn settle(path: &Path, mode: u32, mtime_ms: f64) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.permissions().mode() & 0o777 != mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    if crate::disk::mtime_ms(&meta).trunc() != mtime_ms.trunc() {
        rustix::fs::utimensat(CWD, path, &times(mtime_ms), AtFlags::empty())?;
    }
    Ok(())
}

fn free_bytes(dir: &Path) -> Result<u64, TransferError> {
    let stat = rustix::fs::statvfs(dir).map_err(TransferError::failed)?;
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
}

impl Disk {
    pub(crate) fn new(home: PathBuf, forbidden: &[PathBuf], trash: Trash, clock: Arc<dyn Clock>) -> Self {
        let mut roots: Vec<PathBuf> = Vec::new();
        for root in forbidden {
            let written = normalize(root);
            let real = fs::canonicalize(root).unwrap_or_else(|_| written.clone());
            for path in [written, real] {
                if !roots.contains(&path) {
                    roots.push(path);
                }
            }
        }
        Self { home, forbidden: roots, trash, clock, memory: Mutex::default() }
    }

    pub(crate) fn home(&self) -> &Path {
        &self.home
    }

    fn memory(&self) -> MutexGuard<'_, Memory> {
        self.memory.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn assert_allowed(&self, path: &Path) -> Result<(), TransferError> {
        if self.forbidden.iter().any(|root| path.starts_with(root)) {
            return Err(refuse(Code::ForbiddenDest, "files can't be put inside Eos's own data folder"));
        }
        Ok(())
    }

    /// The destination as it really is on disk, outside Eos's own data.
    fn destination(&self, dir: &str, create: bool) -> Result<PathBuf, TransferError> {
        let abs = absolute(dir)?;
        self.assert_allowed(&abs)?;
        if create {
            fs::create_dir_all(&abs).map_err(|_| refuse(Code::BadPath, format!("can't create {}", abs.display())))?;
        }
        let real =
            fs::canonicalize(&abs).map_err(|_| refuse(Code::NotFound, format!("{} doesn't exist", abs.display())))?;
        self.assert_allowed(&real)?;
        if !real.is_dir() {
            return Err(refuse(Code::BadPath, format!("{} is not a folder", abs.display())));
        }
        Ok(real)
    }

    fn remember(&self, id: &str, session: Arc<Session>) {
        let mut memory = self.memory();
        memory.sessions.retain(|(known, _)| known != id);
        if memory.sessions.len() >= SESSIONS_KEPT {
            memory.sessions.remove(0);
        }
        memory.sessions.push((id.to_owned(), session));
    }

    fn forget(&self, id: &str) {
        self.memory().sessions.retain(|(known, _)| known != id);
    }

    /// The staging a prepare set up: read back from disk after a restart.
    fn session(&self, id: &str, dest_dir: &str) -> Result<Arc<Session>, TransferError> {
        check_id(id)?;
        if let Some((_, session)) = self.memory().sessions.iter().find(|(known, _)| known == id) {
            return Ok(session.clone());
        }
        let real = self.destination(dest_dir, false)?;
        let stage = real.join(STAGING_DIR).join(id);
        let items = read_manifest(&stage);
        if items.is_empty() {
            return Err(refuse(Code::NotFound, "nothing is staged for this transfer"));
        }
        let session = Session::open(real, stage, items)?;
        self.remember(id, session.clone());
        Ok(session)
    }

    pub(crate) fn prepare(&self, request: TransferPrepareRequest) -> Result<TransferPrepareResult, TransferError> {
        check_id(&request.id.0)?;
        let dest_dir = self.destination(&request.dest_dir, true)?;
        let items = valid_items(request.items)?;
        let stage = dest_dir.join(STAGING_DIR).join(&request.id.0);
        let files_root = stage.join("files");
        fs::create_dir_all(&files_root).map_err(TransferError::failed)?;
        // A file staged against another version of itself (it changed since a pause) starts over.
        let before: HashMap<String, ManifestItem> =
            read_manifest(&stage).into_iter().map(|item| (item.rel.clone(), item)).collect();
        for dir in items.iter().filter(|item| item.r#type == ManifestItemType::Dir) {
            fs::create_dir_all(files_root.join(&dir.rel)).map_err(TransferError::failed)?;
        }
        let mut staged: IndexMap<String, i64> = IndexMap::new();
        let mut need: u64 = 0;
        for item in items.iter().filter(|item| item.r#type == ManifestItemType::File) {
            let size = u64::try_from(item.size).unwrap_or(0);
            need += size;
            let path = files_root.join(&item.rel);
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            let same = before.get(&item.rel).is_some_and(|prev| {
                prev.r#type == ManifestItemType::File
                    && prev.size == item.size
                    && prev.mtime_ms.as_f64().trunc() == item.mtime_ms.as_f64().trunc()
            });
            if !meta.is_file() || !same || meta.len() > size {
                remove_any(&path).map_err(TransferError::failed)?;
                continue;
            }
            if meta.len() > 0 {
                staged.insert(item.rel.clone(), i64::try_from(meta.len()).unwrap_or(i64::MAX));
                need -= meta.len();
            }
        }
        let manifest = serde_json::to_vec(&items).map_err(TransferError::failed)?;
        fs::write(stage.join("manifest.json"), manifest).map_err(TransferError::failed)?;

        let mut existing = Vec::new();
        for root in items.iter().filter(|item| !item.rel.contains('/')) {
            if let Ok(meta) = fs::symlink_metadata(dest_dir.join(&root.rel)) {
                existing.push(TransferExisting {
                    name: root.rel.clone(),
                    r#type: item_type(&meta),
                    size: meta.is_file().then(|| i64::try_from(meta.len()).unwrap_or(i64::MAX)),
                    mtime_ms: Num(mtime_ms(&meta)),
                });
            }
        }
        let free = free_bytes(&dest_dir)?;
        self.remember(&request.id.0, Session::open(dest_dir, stage, items)?);
        if need > free {
            let message = format!("needs {} but only {} is free", format_bytes(need), format_bytes(free));
            return Err(refuse(Code::NoSpace, message));
        }
        Ok(TransferPrepareResult { existing, staged, free_bytes: Num(free as f64) })
    }

    /// Appends `data` at `at.offset`, which must be the staged size; answers
    /// the new size.
    pub(crate) fn write(&self, at: &WriteAt, data: &[u8]) -> Result<u64, TransferError> {
        let session = self.session(&at.id, &at.dest_dir)?;
        let Some(&Staged { size, mode, mtime_ms }) = session.files.get(&at.rel) else {
            return Err(refuse(Code::BadPath, format!("{} isn't part of this transfer", at.rel)));
        };
        let end = at.offset.checked_add(data.len() as u64).filter(|end| *end <= size);
        let Some(end) = end else { return Err(refuse(Code::BadPath, format!("more bytes than {} has", at.rel))) };
        let file = session.open_staged(&session.files_root.join(&at.rel))?;
        let held = file.metadata().map_err(TransferError::failed)?.len();
        if held != at.offset {
            let message = format!("{} holds {held} bytes, not {}", at.rel, at.offset);
            return Err(TransferError::offset_mismatch(message, held));
        }
        file.write_all_at(data, at.offset).map_err(TransferError::failed)?;
        if end == size {
            // Complete: its mode and time now, while the file is open, so the
            // commit of a large tree has nothing left to do per file. The owner
            // keeps write access until then (a retried last chunk opens it again).
            file.set_permissions(fs::Permissions::from_mode(mode | 0o600)).map_err(TransferError::failed)?;
            rustix::fs::futimens(&file, &times(mtime_ms)).map_err(TransferError::failed)?;
        }
        Ok(end)
    }

    fn forget_old_commits(&self, memory: &mut Memory) {
        let cutoff = self.clock.now_ms() - COMMIT_MEMORY_MS;
        memory.committed.retain(|(_, at, _)| *at >= cutoff);
    }

    pub(crate) fn commit(&self, request: &TransferCommitRequest) -> Result<TransferCommitResult, TransferError> {
        let id = request.id.0.as_str();
        {
            let mut memory = self.memory();
            self.forget_old_commits(&mut memory);
            if let Some((_, _, result)) = memory.committed.iter().find(|(known, _, _)| known == id) {
                return Ok(result.clone());
            }
        }
        let s = self.session(id, &request.dest_dir)?;
        // A retry after a commit that stopped half-way: what already moved
        // stays moved. Each picked item's outcome is recorded as it lands.
        let progress_path = s.stage.join("placed.json");
        let mut progress = read_progress(&progress_path);
        let pending: Vec<&ManifestItem> =
            s.items.iter().filter(|item| !progress.contains_key(root_of(&item.rel))).collect();

        for item in pending.iter().filter(|item| item.r#type == ManifestItemType::File) {
            let path = s.files_root.join(&item.rel);
            match fs::symlink_metadata(&path) {
                Err(_) if item.size == 0 => drop(s.open_staged(&path)?),
                Ok(meta) if meta.is_file() && i64::try_from(meta.len()).ok() == Some(item.size) => {}
                _ => return Err(refuse(Code::Incomplete, format!("{} isn't fully copied yet", item.rel))),
            }
        }
        // Links last, so nothing was ever written through one.
        for item in pending.iter().filter(|item| item.r#type == ManifestItemType::Link) {
            let path = s.files_root.join(&item.rel);
            if fs::symlink_metadata(&path).is_err() {
                std::os::unix::fs::symlink(item.target.as_deref().unwrap_or_default(), &path)
                    .map_err(TransferError::failed)?;
            }
        }
        // Deepest first: setting a folder's time before its children would undo it.
        let mut by_depth: Vec<&&ManifestItem> =
            pending.iter().filter(|item| item.r#type != ManifestItemType::Link).collect();
        by_depth.sort_by_key(|item| std::cmp::Reverse(item.rel.split('/').count()));
        for item in by_depth {
            // A folder stays enterable and removable by its owner, whatever it was.
            let mode = if item.r#type == ManifestItemType::Dir { mode_of(item) | 0o700 } else { mode_of(item) };
            settle(&s.files_root.join(&item.rel), mode, item.mtime_ms.as_f64()).map_err(TransferError::failed)?;
        }

        // Asked of the disk, not a listing: on a case-insensitive volume
        // "Readme.md" is already there when "README.md" is, and a rename would
        // silently replace it.
        let mut taken: HashSet<String> =
            names_in(&s.dest_dir).map_err(TransferError::failed)?.into_iter().map(|name| name.to_lowercase()).collect();
        for root in s.items.iter().filter(|item| !item.rel.contains('/')) {
            if progress.contains_key(&root.rel) {
                continue;
            }
            let landing = s.dest_dir.join(&root.rel);
            let there = fs::symlink_metadata(&landing).is_ok();
            let decision = if there { request.decisions.get(&root.rel).copied() } else { None };
            if there && decision.is_none() {
                return Err(refuse(Code::ConflictUnresolved, format!("\"{}\" is already there", root.rel)));
            }
            let mut name = None;
            if decision != Some(TransferDecision::Skip) {
                if decision == Some(TransferDecision::Replace) {
                    (self.trash)(&landing).map_err(TransferError::failed)?;
                }
                let placed = match decision {
                    Some(TransferDecision::Keep) => keep_both_name(&root.rel, |n| taken.contains(&n.to_lowercase())),
                    _ => root.rel.clone(),
                };
                fs::rename(s.files_root.join(&root.rel), s.dest_dir.join(&placed)).map_err(TransferError::failed)?;
                taken.insert(placed.to_lowercase());
                name = Some(placed);
            }
            progress.insert(root.rel.clone(), name);
            let pairs: Vec<(&String, &Option<String>)> = progress.iter().collect();
            fs::write(&progress_path, serde_json::to_vec(&pairs).map_err(TransferError::failed)?)
                .map_err(TransferError::failed)?;
        }
        drop_stage(&s.dest_dir, &s.stage).map_err(TransferError::failed)?;
        self.forget(id);
        // Reported under the folder as the caller named it, not its resolved path.
        let shown = absolute(&request.dest_dir)?;
        let result = TransferCommitResult {
            placed: progress
                .values()
                .flatten()
                .map(|name| TransferPlaced { name: name.clone(), path: text(&shown.join(name)) })
                .collect(),
            skipped: progress.iter().filter(|(_, name)| name.is_none()).map(|(root, _)| root.clone()).collect(),
        };
        let mut memory = self.memory();
        if memory.committed.len() >= COMMITS_KEPT {
            memory.committed.remove(0);
        }
        memory.committed.push((id.to_owned(), self.clock.now_ms(), result.clone()));
        Ok(result)
    }

    pub(crate) fn abort(&self, id: &str, dest_dir: &str) -> Result<(), TransferError> {
        check_id(id)?;
        self.forget(id);
        if let Ok(real) = self.destination(dest_dir, false) {
            drop_stage(&real, &real.join(STAGING_DIR).join(id)).map_err(TransferError::failed)?;
        }
        Ok(())
    }
}

fn drop_stage(dest_dir: &Path, stage: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(stage) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    // Gone only when no other transfer is staged there.
    let _ = fs::remove_dir(dest_dir.join(STAGING_DIR));
    Ok(())
}
