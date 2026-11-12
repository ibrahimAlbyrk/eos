//! Reading this computer's disk for a transfer: listing a folder, scanning
//! what was picked, reading a range of a file.

use std::fs::{self, Metadata, OpenOptions};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use eos_contracts::{
    ManifestItem, ManifestItemType, Num, TRANSFER_MAX_CHUNK, TRANSFER_MAX_ITEMS, TransferErrorCode as Code,
    TransferListEntry, TransferListEntryType, TransferListing, TransferManifest,
};
use eos_core::net::transfer::{ByteRange, FileStamp};
use eos_domain::sync::stable::utf16_cmp;
use eos_domain::text::natural_compare;
use eos_domain::transfer::{TransferError, check_absolute, manifest_roots};
use eos_kit_fs::path::normalize;

use crate::staging::STAGING_DIR;

pub(crate) fn refuse(code: Code, message: impl Into<String>) -> TransferError {
    TransferError::new(code, message)
}

/// An absolute path as given, with `.` and `..` resolved by its text.
pub(crate) fn absolute(path: &str) -> Result<PathBuf, TransferError> {
    check_absolute(path)?;
    Ok(normalize(Path::new(path)))
}

pub(crate) fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A file's modification time in milliseconds with its fraction, as Node's
/// `mtimeMs` reads it.
pub(crate) fn mtime_ms(meta: &Metadata) -> f64 {
    let since = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).unwrap_or_default();
    since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1e6
}

pub(crate) fn item_type(meta: &Metadata) -> ManifestItemType {
    if meta.file_type().is_symlink() {
        ManifestItemType::Link
    } else if meta.is_dir() {
        ManifestItemType::Dir
    } else {
        ManifestItemType::File
    }
}

fn size_of(meta: &Metadata) -> i64 {
    i64::try_from(meta.len()).unwrap_or(i64::MAX)
}

/// The names in a folder, in the order the system gives them.
pub(crate) fn names_in(dir: &Path) -> std::io::Result<Vec<String>> {
    fs::read_dir(dir)?.map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned())).collect()
}

fn list_entry(dir: &Path, name: String) -> Option<TransferListEntry> {
    let path = dir.join(&name);
    let own = fs::symlink_metadata(&path).ok()?;
    let is_symlink = own.file_type().is_symlink();
    // A link is listed as what it points at; a broken one as itself.
    let target = if is_symlink { fs::metadata(&path).unwrap_or_else(|_| own.clone()) } else { own };
    let is_dir = target.is_dir();
    if !is_dir && !target.is_file() && !is_symlink {
        return None;
    }
    Some(TransferListEntry {
        name,
        path: text(&path),
        r#type: if is_dir { TransferListEntryType::Directory } else { TransferListEntryType::File },
        is_symlink,
        size: (!is_dir).then(|| size_of(&target)),
        mtime_ms: Num(mtime_ms(&target)),
    })
}

/// A folder as the Transfer tab shows it: folders first, then by name as a
/// person reads it. `.DS_Store`, the staging folder and (unless `hidden`)
/// dot-files are left out.
pub(crate) fn list(home: &Path, dir: &str, hidden: bool) -> Result<TransferListing, TransferError> {
    let abs = absolute(dir)?;
    let meta = fs::metadata(&abs).map_err(|_| refuse(Code::NotFound, format!("{} doesn't exist", abs.display())))?;
    if !meta.is_dir() {
        return Err(refuse(Code::BadPath, format!("{} is not a folder", abs.display())));
    }
    let names = names_in(&abs).map_err(TransferError::failed)?;
    let mut entries: Vec<TransferListEntry> = names
        .into_iter()
        .filter(|name| name != ".DS_Store" && name != STAGING_DIR && (hidden || !name.starts_with('.')))
        .filter_map(|name| list_entry(&abs, name))
        .collect();
    let is_dir = |entry: &TransferListEntry| entry.r#type == TransferListEntryType::Directory;
    entries.sort_by(|a, b| is_dir(b).cmp(&is_dir(a)).then_with(|| natural_compare(&a.name, &b.name)));
    Ok(TransferListing { parent: abs.parent().map(text), path: text(&abs), home: text(home), entries })
}

fn too_many() -> TransferError {
    refuse(Code::TooMany, "more than 100,000 files — zip them first")
}

/// Everything under one picked path, without following links: the item
/// itself, then (for a folder) its children in name order, depth first.
fn walk(root: PathBuf, rel: String, meta: Metadata, items: &mut Vec<ManifestItem>) -> Result<(), TransferError> {
    let mut stack = vec![(root, rel, meta)];
    while let Some((abs, rel, meta)) = stack.pop() {
        if items.len() >= TRANSFER_MAX_ITEMS as usize {
            return Err(too_many());
        }
        let mut item = ManifestItem {
            rel,
            r#type: item_type(&meta),
            size: 0,
            mtime_ms: Num(mtime_ms(&meta)),
            mode: i64::from(meta.mode() & 0o777),
            target: None,
        };
        match item.r#type {
            ManifestItemType::Link => {
                let target = fs::read_link(&abs).map_err(TransferError::failed)?;
                item.target = Some(text(&target));
                items.push(item);
            }
            ManifestItemType::File if meta.is_file() => {
                item.size = size_of(&meta);
                items.push(item);
            }
            // A socket, a device: not something to send.
            ManifestItemType::File => {}
            ManifestItemType::Dir => {
                let mut names = names_in(&abs).map_err(TransferError::failed)?;
                names.retain(|name| name != ".DS_Store" && name != STAGING_DIR);
                // JavaScript's default sort: by UTF-16 code unit.
                names.sort_by(|a, b| utf16_cmp(a, b));
                // Pushed last-first, so the first child is walked next.
                for name in names.into_iter().rev() {
                    let child = abs.join(&name);
                    if let Ok(meta) = fs::symlink_metadata(&child) {
                        stack.push((child, format!("{}/{name}", item.rel), meta));
                    }
                }
                items.push(item);
            }
        }
    }
    Ok(())
}

pub(crate) fn scan(paths: &[String]) -> Result<TransferManifest, TransferError> {
    let mut items = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for path in paths {
        let abs = absolute(path)?;
        let name = abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if names.contains(&name) {
            let message = format!("two picked items are both called \"{name}\" — send them one at a time");
            return Err(refuse(Code::DuplicateName, message));
        }
        let meta = fs::symlink_metadata(&abs)
            .map_err(|_| refuse(Code::NotFound, format!("{} doesn't exist", abs.display())))?;
        walk(abs, name.clone(), meta, &mut items)?;
        names.push(name);
    }
    let files = items.iter().filter(|item| item.r#type == ManifestItemType::File);
    let (total_bytes, file_count) = files.fold((0, 0), |(bytes, count), file| (bytes + file.size, count + 1));
    Ok(TransferManifest { roots: manifest_roots(&items), items, total_bytes, file_count })
}

/// `range` of the file at `path`, refused when the file is not the one that
/// was scanned (`expect`).
pub(crate) fn read(path: &str, range: ByteRange, expect: FileStamp) -> Result<Bytes, TransferError> {
    let abs = absolute(path)?;
    let inside = range.offset.checked_add(range.length).is_some_and(|end| end <= expect.size);
    if range.length < 1 || range.length > TRANSFER_MAX_CHUNK as u64 || !inside {
        return Err(refuse(Code::BadPath, "that range is outside the file"));
    }
    let name = abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(&abs)
        .map_err(|_| refuse(Code::SourceChanged, format!("{name} is gone or was replaced since it was picked")))?;
    let meta = file.metadata().map_err(TransferError::failed)?;
    if !meta.is_file() || meta.len() != expect.size || mtime_ms(&meta).trunc() != expect.mtime_ms.trunc() {
        return Err(refuse(Code::SourceChanged, format!("{name} changed while it was being copied — send it again")));
    }
    let mut buf = vec![0u8; range.length as usize];
    let mut got = 0;
    while got < buf.len() {
        match file.read_at(&mut buf[got..], range.offset + got as u64) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(TransferError::failed(e)),
        }
    }
    buf.truncate(got);
    Ok(Bytes::from(buf))
}
