//! Everything here is checked against bytes the TypeScript code produced
//! (fixtures/update, written by ts/gen-update-vectors.ts).

use std::{fs, path::PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use spike_update::{
    chunker::{ContentChunker, chunk_lengths, scan},
    manifest::{UpdateEntry, UpdateManifest},
    pointer::{self, SignedUpdatePointer},
    testgen::{Gen, generate},
};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/update")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn throwaway_key() -> ed25519_dalek::SigningKey {
    use rand_core::RngCore;
    let mut seed = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut seed);
    ed25519_dalek::SigningKey::from_bytes(&seed)
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    r#gen: Gen,
    sha256: String,
    lengths: Vec<usize>,
    ids: Vec<String>,
}

#[test]
fn cut_points_and_chunk_ids_match_the_typescript_chunker() {
    let vectors: Vec<Vector> =
        serde_json::from_slice(&fs::read(fixtures().join("chunker-vectors.json")).unwrap()).unwrap();
    assert!(vectors.len() >= 15);
    for v in vectors {
        let data = generate(&v.r#gen);
        assert_eq!(sha256_hex(&data), v.sha256, "{}: the generators disagree", v.name);
        assert_eq!(chunk_lengths(&data), v.lengths, "{}: cut points", v.name);
        let (_, chunks) = scan(&data);
        assert_eq!(chunks.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), v.ids, "{}: chunk ids", v.name);

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

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    r#gen: Option<Gen>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    public_key: String,
    tree: Vec<TreeEntry>,
    second_app_js: Gen,
}

fn release() -> Release {
    serde_json::from_slice(&fs::read(fixtures().join("release.json")).unwrap()).unwrap()
}

#[test]
fn a_manifest_written_by_typescript_survives_a_round_trip_byte_for_byte() {
    for version in ["9.0.0", "9.0.1"] {
        let bytes = fs::read(fixtures().join(format!("manifest-{version}.json"))).unwrap();
        let manifest = UpdateManifest::parse(&bytes).unwrap();
        assert_eq!(serde_json::to_vec(&manifest).unwrap(), bytes, "manifest {version}");
    }
}

#[test]
fn the_pointer_verifies_pins_the_manifest_and_round_trips() {
    let rel = release();
    let keys = [pointer::verifying_key(&rel.public_key).unwrap()];
    for version in ["9.0.0", "9.0.1"] {
        let raw = fs::read(fixtures().join(format!("pointer-{version}.json"))).unwrap();
        let signed: SignedUpdatePointer = serde_json::from_slice(&raw).unwrap();
        assert_eq!(serde_json::to_vec(&signed).unwrap(), raw, "the wrapper re-serializes to the same bytes");

        let ptr = pointer::open(&signed, &keys).unwrap();
        assert_eq!(ptr.version, version);
        assert_eq!(serde_json::to_string(&ptr).unwrap(), signed.payload, "the payload re-serializes to the same bytes");

        let packed = fs::read(fixtures().join("feed").join(&ptr.manifest.path)).unwrap();
        assert_eq!(packed.len() as u64, ptr.manifest.size);
        assert_eq!(sha256_hex(&packed), ptr.manifest.sha256);
        let plain = zstd::decode_all(&packed[..]).unwrap();
        assert_eq!(plain, fs::read(fixtures().join(format!("manifest-{version}.json"))).unwrap());

        // One flipped bit in the payload, or another key, must not verify.
        let mut tampered = signed.payload.clone().into_bytes();
        tampered[10] ^= 1;
        assert!(!pointer::verify(std::str::from_utf8(&tampered).unwrap(), &signed.signature, &keys));
        let other = throwaway_key().verifying_key();
        assert!(!pointer::verify(&signed.payload, &signed.signature, &[other]));
    }
}

#[test]
fn a_pointer_signed_here_verifies_here() {
    use base64::Engine;
    use ed25519_dalek::pkcs8::EncodePrivateKey;
    let key = throwaway_key();
    let pkcs8 = base64::engine::general_purpose::STANDARD.encode(key.to_pkcs8_der().unwrap().as_bytes());
    let payload = r#"{"version":"9.9.9","platform":"darwin-arm64"}"#;
    let signature = pointer::sign(payload, &pkcs8).unwrap();
    assert_eq!(signature.len(), 88, "64 bytes in padded base64, as the zod schema demands");
    assert!(pointer::verify(payload, &signature, &[key.verifying_key()]));
}

/// The installed app indexes its own bundle with the same chunker; every chunk
/// it finds must be the chunk the publisher listed, and every frame in the pack
/// must inflate to it.
#[test]
fn the_publishers_chunks_are_the_ones_this_chunker_finds_and_the_packs_inflate() {
    let rel = release();
    for version in ["9.0.0", "9.0.1"] {
        let manifest =
            UpdateManifest::parse(&fs::read(fixtures().join(format!("manifest-{version}.json"))).unwrap()).unwrap();
        let packs: Vec<Vec<u8>> =
            manifest.packs.iter().map(|p| fs::read(fixtures().join("feed").join(p)).unwrap()).collect();
        let frame = |pack: u32, offset: u64, zsize: u64| -> Vec<u8> {
            let bytes = &packs[pack as usize][offset as usize..(offset + zsize) as usize];
            zstd::decode_all(bytes).unwrap()
        };

        let mut files = 0;
        for entry in &manifest.entries {
            let UpdateEntry::File { path, size, sha256, chunks, whole, .. } = entry else { continue };
            let g = rel.tree.iter().find(|t| &t.path == path).and_then(|t| t.r#gen.clone()).unwrap();
            let g = if version == "9.0.1" && path.ends_with("app.js") { rel.second_app_js.clone() } else { g };
            let data = generate(&g);
            let (whole_hash, scanned) = scan(&data);
            assert_eq!((data.len() as u64, &whole_hash), (*size, sha256), "{path}");
            assert_eq!(scanned.len(), chunks.len(), "{path}: chunk count");
            for (found, &index) in scanned.iter().zip(chunks) {
                let listed = &manifest.chunks[index as usize];
                assert_eq!((&found.id, found.size as u64), (&listed.id, listed.size), "{path}");
                let inflated = frame(listed.pack, listed.offset, listed.zsize);
                assert_eq!(sha256_hex(&inflated), listed.id, "{path}: frame content");
            }
            if let Some(w) = whole {
                assert_eq!(sha256_hex(&frame(w.pack, w.offset, w.zsize)), *sha256, "{path}: whole-file frame");
            }
            files += 1;
        }
        assert_eq!(files, 5);
    }
    let second = UpdateManifest::parse(&fs::read(fixtures().join("manifest-9.0.1.json")).unwrap()).unwrap();
    assert!(
        second.entries.iter().any(|e| matches!(e, UpdateEntry::File { whole: Some(_), .. })),
        "a whole-file frame is covered"
    );
}
