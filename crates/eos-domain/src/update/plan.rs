//! What an update costs, decided before a byte moves: which files are already installed
//! as they are, which are rebuilt from chunks on disk plus downloaded ones, and the few
//! byte ranges to fetch from the packs. The indexer says what is on disk, the manifest
//! says what should be.
//!
//! Numbers are `i64` as in the manifest; a manifest reaches this only after
//! its schema and [`manifest_problem`](super::manifest_problem) passed, so
//! none is negative and every index is in range.

use std::collections::{HashMap, HashSet};

use eos_contracts::update::{PackSpan, UpdateEntry, UpdateManifest};

/// Where a chunk's bytes already are, inside the installed bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalChunk {
    pub path: String,
    pub offset: i64,
    pub size: i64,
}

/// What the installed bundle holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BundleIndex {
    /// sha256 of an installed file → its path in the bundle.
    pub files: HashMap<String, String>,
    /// chunk id → where its bytes already are.
    pub chunks: HashMap<String, LocalChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilePart {
    /// Bytes of an installed file.
    Disk { path: String, offset: i64, size: i64 },
    /// A downloaded chunk (an index into the manifest's chunks).
    Pack { chunk: usize },
}

#[derive(Debug, Clone, PartialEq)]
pub enum FileStep {
    /// The installed file `source` is this file already.
    Copy {
        path: String,
        source: String,
    },
    Assemble {
        path: String,
        parts: Vec<FilePart>,
    },
    /// One downloaded frame is the whole file.
    Whole {
        path: String,
        span: PackSpan,
    },
}

impl FileStep {
    pub fn path(&self) -> &str {
        match self {
            Self::Copy { path, .. } | Self::Assemble { path, .. } | Self::Whole { path, .. } => path,
        }
    }
}

/// A run of bytes to fetch from one pack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FetchRange {
    pub pack: i64,
    pub offset: i64,
    pub length: i64,
}

impl FetchRange {
    fn end(&self) -> i64 {
        self.offset + self.length
    }

    /// The span's frame lies wholly inside this range.
    pub fn holds(&self, pack: i64, offset: i64, zsize: i64) -> bool {
        self.pack == pack && offset >= self.offset && offset + zsize <= self.end()
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdatePlan {
    pub files: Vec<FileStep>,
    pub ranges: Vec<FetchRange>,
    pub download_bytes: i64,
    pub reused_bytes: i64,
}

/// Bridging a gap this small costs less than another request.
pub const RANGE_MAX_GAP: i64 = 64 * 1024;
/// A request stays small enough to retry cheaply.
pub const RANGE_MAX_LENGTH: i64 = 16 * 1024 * 1024;

pub fn plan_update(index: &BundleIndex, manifest: &UpdateManifest) -> UpdatePlan {
    let mut files = Vec::new();
    let mut spans: Vec<FetchRange> = Vec::new();
    let mut queued: HashSet<usize> = HashSet::new();
    let mut reused_bytes = 0;

    for entry in &manifest.entries {
        let UpdateEntry::File(entry) = entry else { continue };
        if let Some(installed) = index.files.get(&entry.sha256) {
            files.push(FileStep::Copy { path: entry.path.clone(), source: installed.clone() });
            reused_bytes += entry.size;
            continue;
        }

        let mut parts: Vec<FilePart> = Vec::new();
        // In file order: the ranges of a release are requested in this order.
        let mut missing: Vec<usize> = Vec::new();
        let mut missing_cost = 0;
        let mut from_disk = 0;
        for i in &entry.chunks {
            let Some((i, chunk)) = usize::try_from(*i).ok().and_then(|i| Some((i, manifest.chunks.get(i)?))) else {
                continue;
            };
            if let Some(local) = index.chunks.get(&chunk.id) {
                push_disk_part(&mut parts, local);
                from_disk += chunk.size;
                continue;
            }
            parts.push(FilePart::Pack { chunk: i });
            if !queued.contains(&i) && !missing.contains(&i) {
                missing.push(i);
                missing_cost += chunk.zsize;
            }
        }

        if let Some(whole) = &entry.whole
            && whole.zsize < missing_cost
        {
            files.push(FileStep::Whole { path: entry.path.clone(), span: whole.clone() });
            spans.push(FetchRange { pack: whole.pack, offset: whole.offset, length: whole.zsize });
            continue;
        }
        for i in missing {
            queued.insert(i);
            let c = &manifest.chunks[i];
            spans.push(FetchRange { pack: c.pack, offset: c.offset, length: c.zsize });
        }
        files.push(FileStep::Assemble { path: entry.path.clone(), parts });
        reused_bytes += from_disk;
    }

    let ranges = coalesce_spans(&spans);
    let download_bytes = ranges.iter().map(|r| r.length).sum();
    UpdatePlan { files, ranges, download_bytes, reused_bytes }
}

/// Consecutive chunks of one installed file read as one part.
fn push_disk_part(parts: &mut Vec<FilePart>, local: &LocalChunk) {
    if let Some(FilePart::Disk { path, offset, size }) = parts.last_mut()
        && *path == local.path
        && *offset + *size == local.offset
    {
        *size += local.size;
        return;
    }
    parts.push(FilePart::Disk { path: local.path.clone(), offset: local.offset, size: local.size });
}

/// The chunks whose frames lie wholly inside a fetched range (indexes into
/// the manifest's chunks) — what its bytes can be checked against.
pub fn chunks_within(manifest: &UpdateManifest, range: &FetchRange) -> Vec<usize> {
    manifest.chunks.iter().enumerate().filter(|(_, c)| range.holds(c.pack, c.offset, c.zsize)).map(|(i, _)| i).collect()
}

/// Joins spans (each given as a range of its own) that lie close together in
/// one pack, up to [`RANGE_MAX_LENGTH`].
pub fn coalesce_spans(spans: &[FetchRange]) -> Vec<FetchRange> {
    let mut sorted = spans.to_vec();
    // Stable, as JavaScript's sort: equal spans keep their order.
    sorted.sort_by_key(|s| (s.pack, s.offset));
    let mut ranges: Vec<FetchRange> = Vec::new();
    for span in sorted {
        let end = span.end();
        if let Some(last) = ranges.last_mut()
            && last.pack == span.pack
            && span.offset - last.end() <= RANGE_MAX_GAP
            && end - last.offset <= RANGE_MAX_LENGTH
        {
            last.length = last.length.max(end - last.offset);
            continue;
        }
        ranges.push(span);
    }
    ranges
}

#[cfg(test)]
mod tests {
    use eos_contracts::primitives::IntLit;
    use eos_contracts::update::{AppVersion, UpdateChunk, UpdateEntryDir, UpdateEntryFile, UpdatePlatform};

    use super::*;

    fn hash(n: u64) -> String {
        format!("{n:064x}")
    }

    fn manifest_of(entries: Vec<UpdateEntry>) -> UpdateManifest {
        // Pack 0 holds chunks 0..4 back to back; chunk 5 sits far away.
        let chunk = |n: u64, offset: i64, zsize: i64| UpdateChunk { id: hash(n), size: 100, pack: 0, offset, zsize };
        UpdateManifest {
            format: IntLit,
            version: AppVersion("0.1.3".into()),
            platform: UpdatePlatform::DarwinArm64,
            packs: vec!["packs/darwin-arm64/0.1.3.pack".into()],
            chunks: vec![
                chunk(10, 0, 40),
                chunk(11, 40, 40),
                chunk(12, 80, 40),
                chunk(13, 120, 40),
                chunk(14, 160, 90),
                chunk(15, 10_000_000, 30),
            ],
            entries,
        }
    }

    fn entry(path: &str, sha: u64, ids: &[i64], whole: Option<PackSpan>) -> UpdateEntry {
        UpdateEntry::File(UpdateEntryFile {
            path: path.into(),
            mode: 0o644,
            size: ids.len() as i64 * 100,
            sha256: hash(sha),
            chunks: ids.to_vec(),
            whole,
        })
    }

    fn index() -> BundleIndex {
        let local = |offset| LocalChunk { path: "Contents/Old".into(), offset, size: 100 };
        BundleIndex {
            files: HashMap::from([(hash(1), "Contents/Same".to_owned())]),
            chunks: HashMap::from([(hash(10), local(0)), (hash(11), local(100))]),
        }
    }

    #[test]
    fn installed_files_are_copied_and_the_rest_rebuilt_from_disk_and_packs() {
        let manifest = manifest_of(vec![
            UpdateEntry::Dir(UpdateEntryDir { path: "Contents".into(), mode: 0o755 }),
            entry("Contents/Same", 1, &[0], None),
            entry("Contents/B", 2, &[0, 1, 2], None),
            entry("Contents/C", 3, &[2, 3], None),
        ]);
        let plan = plan_update(&index(), &manifest);
        assert_eq!(
            plan.files,
            vec![
                FileStep::Copy { path: "Contents/Same".into(), source: "Contents/Same".into() },
                FileStep::Assemble {
                    path: "Contents/B".into(),
                    parts: vec![
                        FilePart::Disk { path: "Contents/Old".into(), offset: 0, size: 200 },
                        FilePart::Pack { chunk: 2 },
                    ],
                },
                FileStep::Assemble {
                    path: "Contents/C".into(),
                    parts: vec![FilePart::Pack { chunk: 2 }, FilePart::Pack { chunk: 3 }],
                },
            ]
        );
        // Chunk 2 is needed twice but fetched once, in one range with chunk 3.
        assert_eq!(plan.ranges, vec![FetchRange { pack: 0, offset: 80, length: 80 }]);
        assert_eq!(plan.download_bytes, 80);
        assert_eq!(plan.reused_bytes, 100 + 200);
    }

    #[test]
    fn a_file_is_taken_whole_when_its_chunks_would_cost_more() {
        let whole = PackSpan { pack: 0, offset: 20_000_000, zsize: 50 };
        let plan = plan_update(&index(), &manifest_of(vec![entry("Contents/D", 4, &[4], Some(whole.clone()))]));
        assert_eq!(plan.files, vec![FileStep::Whole { path: "Contents/D".into(), span: whole }]);
        assert_eq!(plan.ranges, vec![FetchRange { pack: 0, offset: 20_000_000, length: 50 }]);
    }

    #[test]
    fn nothing_is_downloaded_when_every_chunk_is_on_disk() {
        let plan = plan_update(&index(), &manifest_of(vec![entry("Contents/E", 5, &[1, 0], None)]));
        assert!(plan.ranges.is_empty());
        assert_eq!(plan.reused_bytes, 200);
    }

    #[test]
    fn nearby_spans_join_and_far_or_oversized_ones_split() {
        let span = |pack, offset, length| FetchRange { pack, offset, length };
        assert_eq!(
            coalesce_spans(&[
                span(0, 0, 10),
                span(0, 10 + RANGE_MAX_GAP, 10),
                span(0, 20 + 2 * RANGE_MAX_GAP + 1, 10),
                span(1, 0, 10),
            ]),
            vec![span(0, 0, 20 + RANGE_MAX_GAP), span(0, 20 + 2 * RANGE_MAX_GAP + 1, 10), span(1, 0, 10)]
        );
        let big = RANGE_MAX_LENGTH - 5;
        assert_eq!(coalesce_spans(&[span(0, 0, big), span(0, big, 10)]).len(), 2);
    }

    #[test]
    fn the_chunks_inside_a_range_are_the_ones_it_can_be_checked_against() {
        let manifest = manifest_of(vec![]);
        assert_eq!(chunks_within(&manifest, &FetchRange { pack: 0, offset: 40, length: 100 }), vec![1, 2]);
        assert!(chunks_within(&manifest, &FetchRange { pack: 1, offset: 0, length: 1000 }).is_empty());
    }
}
