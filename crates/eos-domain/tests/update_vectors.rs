//! The update rules against bytes the TypeScript code produced
//! (`fixtures/update`, frozen from the TypeScript, see `fixtures/README.md`).

use eos_contracts::update::{SignedUpdatePointer, UpdateEntry, UpdatePlatform};
use eos_domain::update::{
    BundleIndex, ContentChunker, FileStep, LocalChunk, chunk_lengths, manifest_problem, offered_release,
    parse_manifest, parse_signed_pointer, plan_update,
};
use eos_testkit::update::{Gen, generate, noise, read, release, sha256_hex};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    name: String,
    r#gen: Gen,
    sha256: String,
    lengths: Vec<usize>,
    ids: Vec<String>,
}

fn chunk_ids(data: &[u8]) -> Vec<String> {
    let mut offset = 0;
    chunk_lengths(data)
        .into_iter()
        .map(|size| {
            let id = sha256_hex(&data[offset..offset + size]);
            offset += size;
            id
        })
        .collect()
}

#[test]
fn cut_points_and_chunk_ids_match_the_typescript_chunker() {
    let vectors: Vec<Vector> = serde_json::from_slice(&read("chunker-vectors.json")).expect("vectors");
    assert!(vectors.len() >= 15);
    for v in vectors {
        let data = generate(&v.r#gen);
        assert_eq!(sha256_hex(&data), v.sha256, "{}: the generators disagree", v.name);
        assert_eq!(chunk_lengths(&data), v.lengths, "{}: cut points", v.name);
        assert_eq!(chunk_ids(&data), v.ids, "{}: chunk ids", v.name);

        // Feeding the stream in slices must not move a cut.
        for slice in [1usize, 7, 4096, 65_537] {
            if slice == 1 && data.len() > 300_000 {
                continue;
            }
            let mut chunker = ContentChunker::new();
            let mut lengths = Vec::new();
            for part in data.chunks(slice) {
                chunker.push(part, &mut lengths);
            }
            lengths.extend(chunker.end());
            assert_eq!(lengths, v.lengths, "{}: slices of {slice}", v.name);
        }
    }
}

#[test]
fn an_edit_moves_only_the_cuts_around_it() {
    let before = noise(4 * 1024 * 1024, 23);
    let mid = 2 * 1024 * 1024;
    let mut after = before[..mid].to_vec();
    after.extend_from_slice(&noise(100, 5));
    after.extend_from_slice(&before[mid..]);
    let known = chunk_ids(&before);
    let ids = chunk_ids(&after);
    let changed = ids.iter().filter(|id| !known.contains(id)).count();
    assert!(changed <= 3, "{changed} of {} chunks changed", ids.len());
}

#[test]
fn a_manifest_written_by_typescript_survives_a_round_trip_byte_for_byte() {
    for version in ["9.0.0", "9.0.1"] {
        let bytes = read(&format!("manifest-{version}.json"));
        let manifest = parse_manifest(&bytes).expect("a manifest");
        assert_eq!(manifest_problem(&manifest), None);
        assert_eq!(serde_json::to_vec(&manifest).expect("json"), bytes, "manifest {version}");
    }
}

#[test]
fn a_pointer_written_by_typescript_round_trips_and_names_its_manifest() {
    for version in ["9.0.0", "9.0.1"] {
        let raw = read(&format!("pointer-{version}.json"));
        let signed: SignedUpdatePointer = parse_signed_pointer(&raw).expect("a pointer");
        assert_eq!(serde_json::to_vec(&signed).expect("json"), raw, "the wrapper re-serializes to the same bytes");

        let pointer =
            offered_release(&signed, true, UpdatePlatform::DarwinArm64, "0.0.0").expect("checked").expect("newer");
        assert_eq!(pointer.version.0, version);
        assert_eq!(serde_json::to_string(&pointer).expect("json"), signed.payload, "the payload re-serializes too");

        let packed = read(&format!("feed/{}", pointer.manifest.path));
        assert_eq!(packed.len() as i64, pointer.manifest.size);
        assert_eq!(sha256_hex(&packed), pointer.manifest.sha256);
        assert_eq!(offered_release(&signed, true, UpdatePlatform::DarwinArm64, version).expect("checked"), None);
    }
}

/// The installed app indexes its own bundle with the same chunker: every chunk
/// it finds must be the chunk the publisher listed.
#[test]
fn the_publishers_chunks_are_the_ones_this_chunker_finds() {
    let rel = release();
    for (version, second) in [("9.0.0", false), ("9.0.1", true)] {
        let manifest = parse_manifest(&read(&format!("manifest-{version}.json"))).expect("a manifest");
        let mut files = 0;
        for entry in &manifest.entries {
            let UpdateEntry::File(file) = entry else { continue };
            let source = rel.tree.iter().find(|t| t.path == file.path).expect("in the tree");
            let data = rel.file_bytes(source, second);
            assert_eq!((data.len() as i64, sha256_hex(&data)), (file.size, file.sha256.clone()), "{}", file.path);
            let listed: Vec<&str> = file.chunks.iter().map(|i| manifest.chunks[*i as usize].id.as_str()).collect();
            assert_eq!(chunk_ids(&data), listed, "{}", file.path);
            files += 1;
        }
        assert_eq!(files, rel.tree.iter().filter(|t| t.r#gen.is_some()).count());
    }
}

/// From 9.0.0 installed to 9.0.1: the plan copies what did not change, takes
/// the rewritten file whole and fetches only the second release's pack.
#[test]
fn the_plan_from_one_fixture_release_to_the_next_fetches_only_the_new_pack() {
    let rel = release();
    let first = parse_manifest(&read("manifest-9.0.0.json")).expect("a manifest");
    let second = parse_manifest(&read("manifest-9.0.1.json")).expect("a manifest");

    let mut index = BundleIndex::default();
    for entry in &first.entries {
        let UpdateEntry::File(file) = entry else { continue };
        index.files.entry(file.sha256.clone()).or_insert_with(|| file.path.clone());
        let mut offset = 0;
        for i in &file.chunks {
            let c = &first.chunks[*i as usize];
            index.chunks.entry(c.id.clone()).or_insert_with(|| LocalChunk {
                path: file.path.clone(),
                offset,
                size: c.size,
            });
            offset += c.size;
        }
    }

    let plan = plan_update(&index, &second);
    let new_pack = second.packs.iter().position(|p| p.ends_with("9.0.1.pack")).expect("the new pack") as i64;
    assert!(plan.ranges.iter().all(|r| r.pack == new_pack), "{:?}", plan.ranges);
    assert!(plan.download_bytes > 0 && plan.download_bytes < rel.built["9.0.1"].pack_bytes as i64);
    let step = |path: &str| plan.files.iter().find(|s| s.path() == path).expect("planned");
    assert!(matches!(step("Contents/Info.plist"), FileStep::Copy { .. }));
    assert!(matches!(step("Contents/Resources/app.js"), FileStep::Whole { .. }));
    assert!(matches!(step("Contents/MacOS/Eos"), FileStep::Assemble { parts, .. } if parts.len() == 3));
}
