//! Turns a built app bundle into a release on the feed: its manifest, one pack
//! holding only the chunks the previous release did not have, and the signed
//! pointer. Everything lands under `out_dir` in the feed's own layout, so
//! publishing is a plain upload of that tree (pointer last).
//!
//! For one input tree the output is byte for byte what the TypeScript builder
//! writes (`tests/publish.rs` holds it to `fixtures/update`): same scan order,
//! same chunks, same zstd frames (libzstd 1.5.7 on both sides), same JSON.
//!
//! Synchronous and heavy: call it from a blocking thread.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use eos_contracts::primitives::IntLit;
use eos_contracts::update::{
    AppVersion, PackSpan, SignedUpdatePointer, UpdateChunk, UpdateEntry, UpdateEntryDir, UpdateEntryFile,
    UpdateEntryLink, UpdateManifest, UpdatePlatform, UpdatePointer, UpdatePointerManifest,
};
use eos_contracts::validate;
use eos_domain::update::{manifest_problem, platform_name};

use crate::error::Error;
use crate::scan::{ScannedEntry, scan_bundle, sha256_hex};
use crate::signature::sign_payload;

/// Every install downloads a release's new chunks, so they get zstd's best.
const DEFAULT_LEVEL: i32 = 19;
/// A platform's first pack is the whole bundle, which installs already hold
/// and almost never fetch — a quick level keeps that publish to seconds.
const FIRST_PACK_LEVEL: i32 = 9;
/// A changed file is weighed whole only when its new chunks cost more than
/// this and make up most of it — a binary whose signature alone changed never
/// wins, and compressing hundreds of MB to find that out costs minutes.
const WHOLE_MIN_COST: i64 = 64 * 1024;
const WHOLE_MIN_SHARE: f64 = 0.5;
/// …and taken whole only when that saves a tenth or more.
const WHOLE_GAIN: f64 = 0.9;

#[derive(Debug, Clone)]
pub struct ReleaseInput<'a> {
    pub app_root: &'a Path,
    pub version: &'a str,
    pub platform: UpdatePlatform,
    /// The release users update from; `None` for the first one on the feed.
    pub previous: Option<&'a UpdateManifest>,
    pub out_dir: &'a Path,
    pub notes: Option<&'a str>,
    /// PKCS#8 DER in base64.
    pub signing_key: &'a str,
    /// The pointer's `releasedAt`: `2026-11-11T00:00:00.000Z`.
    pub released_at: &'a str,
    /// zstd level, when not the default for this release.
    pub level: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct BuiltRelease {
    pub manifest: UpdateManifest,
    /// Feed paths written under `out_dir`, the pointer last.
    pub files: Vec<String>,
    pub pointer_path: String,
    pub pack_bytes: i64,
    pub new_chunks: usize,
    pub whole_files: usize,
}

pub fn build_release(input: &ReleaseInput<'_>) -> Result<BuiltRelease, Error> {
    let ReleaseInput { version, platform, previous, out_dir, .. } = *input;
    let platform_dir = platform_name(platform);
    let pack_path = format!("packs/{platform_dir}/{version}.pack");
    let scanned = scan_bundle(input.app_root, true).map_err(Error::io(input.app_root))?;

    // Chunks the feed already holds, by id, with the pack that has them.
    let mut known: HashMap<&str, (&UpdateChunk, &str)> = HashMap::new();
    let mut previous_files: HashSet<&str> = HashSet::new();
    if let Some(previous) = previous {
        for c in &previous.chunks {
            let pack = usize::try_from(c.pack).ok().and_then(|i| previous.packs.get(i));
            let pack =
                pack.ok_or_else(|| Error::Release(format!("the previous manifest's chunk {} names no pack", c.id)))?;
            known.insert(&c.id, (c, pack));
        }
        for e in &previous.entries {
            if let UpdateEntry::File(file) = e {
                previous_files.insert(&file.sha256);
            }
        }
    }

    let level = input.level.unwrap_or(if previous.is_some() { DEFAULT_LEVEL } else { FIRST_PACK_LEVEL });
    let mut zstd = zstd::bulk::Compressor::new(level).map_err(|e| Error::Release(format!("zstd: {e}")))?;
    let mut compress = |bytes: &[u8]| zstd.compress(bytes).map_err(|e| Error::Release(format!("zstd: {e}")));
    let mut pack = PackWriter { path: out_dir.join(&pack_path), file: None, size: 0 };
    let mut packs: Vec<String> = Vec::new();
    let mut pack_index = |path: &str| -> i64 {
        let at = packs.iter().position(|p| p == path).unwrap_or_else(|| {
            packs.push(path.to_owned());
            packs.len() - 1
        });
        at as i64
    };
    let mut chunks: Vec<UpdateChunk> = Vec::new();
    let mut chunk_index: HashMap<String, usize> = HashMap::new();
    let mut entries: Vec<UpdateEntry> = Vec::new();
    let (mut new_chunks, mut whole_files) = (0, 0);

    for e in scanned {
        let (path, mode, size, sha256, file_chunks) = match e {
            ScannedEntry::Dir { path, mode } => {
                entries.push(UpdateEntry::Dir(UpdateEntryDir { path, mode }));
                continue;
            }
            ScannedEntry::Link { path, target } => {
                entries.push(UpdateEntry::Link(UpdateEntryLink { path, target }));
                continue;
            }
            ScannedEntry::File { path, mode, size, sha256, chunks } => (path, mode, size, sha256, chunks),
        };
        let abs = input.app_root.join(&path);
        let mut file = File::open(&abs).map_err(Error::io(&abs))?;
        let mut ids = Vec::with_capacity(file_chunks.len());
        let (mut added_cost, mut total_cost) = (0i64, 0i64);
        for c in file_chunks {
            let i = match chunk_index.get(&c.id) {
                Some(i) => *i,
                None => {
                    let (pack_at, offset, zsize) = match known.get(c.id.as_str()) {
                        Some((old, old_pack)) => (pack_index(old_pack), old.offset, old.zsize),
                        None => {
                            let frame = compress(&read_at(&mut file, &abs, c.offset, c.size)?)?;
                            let (offset, zsize) = pack.append(&frame)?;
                            added_cost += zsize;
                            new_chunks += 1;
                            (pack_index(&pack_path), offset, zsize)
                        }
                    };
                    chunks.push(UpdateChunk { pack: pack_at, offset, zsize, id: c.id.clone(), size: c.size });
                    chunk_index.insert(c.id, chunks.len() - 1);
                    chunks.len() - 1
                }
            };
            total_cost += chunks[i].zsize;
            ids.push(i as i64);
        }
        let mut whole = None;
        if previous.is_some()
            && !previous_files.contains(sha256.as_str())
            && added_cost > WHOLE_MIN_COST
            && added_cost as f64 >= total_cost as f64 * WHOLE_MIN_SHARE
        {
            let frame = compress(&read_at(&mut file, &abs, 0, size)?)?;
            if (frame.len() as f64) < added_cost as f64 * WHOLE_GAIN {
                let (offset, zsize) = pack.append(&frame)?;
                whole = Some(PackSpan { pack: pack_index(&pack_path), offset, zsize });
                whole_files += 1;
            }
        }
        entries.push(UpdateEntry::File(UpdateEntryFile { path, mode, size, sha256, chunks: ids, whole }));
    }
    drop(pack.file.take());

    let manifest =
        UpdateManifest { format: IntLit, version: AppVersion(version.to_owned()), platform, packs, chunks, entries };
    validate::check(&manifest).map_err(|e| Error::Release(format!("the built manifest is malformed: {e}")))?;
    if let Some(problem) = manifest_problem(&manifest) {
        return Err(Error::Release(format!("the built manifest is unsound: {problem}")));
    }

    let mut files = Vec::new();
    if pack.size > 0 {
        files.push(pack_path);
    }
    let manifest_path = format!("releases/{version}/{platform_dir}.manifest.json.zst");
    let json = serde_json::to_vec(&manifest).map_err(|e| Error::Release(e.to_string()))?;
    let packed = compress(&json)?;
    put(out_dir, &manifest_path, &packed)?;
    files.push(manifest_path.clone());

    let notes_path = match input.notes {
        Some(notes) if !notes.is_empty() => {
            let path = format!("notes/{version}.md");
            put(out_dir, &path, notes.as_bytes())?;
            files.push(path.clone());
            Some(path)
        }
        _ => None,
    };

    let pointer = UpdatePointer {
        version: AppVersion(version.to_owned()),
        platform,
        manifest: UpdatePointerManifest { path: manifest_path, sha256: sha256_hex(&packed), size: packed.len() as i64 },
        notes: notes_path,
        released_at: input.released_at.to_owned(),
        feed_url: None,
    };
    validate::check(&pointer).map_err(|e| Error::Release(format!("the built pointer is malformed: {e}")))?;
    let payload = serde_json::to_string(&pointer).map_err(|e| Error::Release(e.to_string()))?;
    let signed = SignedUpdatePointer { signature: sign_payload(&payload, input.signing_key)?, payload };
    let pointer_path = format!("stable/{platform_dir}.json");
    put(out_dir, &pointer_path, &serde_json::to_vec(&signed).map_err(|e| Error::Release(e.to_string()))?)?;
    files.push(pointer_path.clone());

    Ok(BuiltRelease { manifest, files, pointer_path, pack_bytes: pack.size, new_chunks, whole_files })
}

fn read_at(file: &mut File, path: &Path, offset: i64, size: i64) -> Result<Vec<u8>, Error> {
    let changed = || Error::Release(format!("{} changed while the release was being built", path.display()));
    let mut buf = vec![0u8; usize::try_from(size).map_err(|_| changed())?];
    file.seek(SeekFrom::Start(u64::try_from(offset).map_err(|_| changed())?)).map_err(Error::io(path))?;
    file.read_exact(&mut buf).map_err(|_| changed())?;
    Ok(buf)
}

fn put(out_dir: &Path, path: &str, bytes: &[u8]) -> Result<(), Error> {
    let abs = out_dir.join(path);
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(Error::io(parent))?;
    }
    fs::write(&abs, bytes).map_err(Error::io(&abs))
}

/// Appends zstd frames to the release's pack; opened only once a frame comes.
struct PackWriter {
    path: PathBuf,
    file: Option<File>,
    size: i64,
}

impl PackWriter {
    /// Where the frame landed: its offset and its size.
    fn append(&mut self, frame: &[u8]) -> Result<(i64, i64), Error> {
        let file = match &mut self.file {
            Some(file) => file,
            None => {
                if let Some(parent) = self.path.parent() {
                    fs::create_dir_all(parent).map_err(Error::io(parent))?;
                }
                self.file.insert(File::create(&self.path).map_err(Error::io(&self.path))?)
            }
        };
        file.write_all(frame).map_err(Error::io(&self.path))?;
        let offset = self.size;
        self.size += frame.len() as i64;
        Ok((offset, frame.len() as i64))
    }
}
