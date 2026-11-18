//! A blueprint's canonical JSON and hash against
//! `tests/fixtures/blueprint-vectors.json`. Each vector's `canonical` was
//! written by JavaScript's `JSON.stringify` from an object whose keys were
//! typed in the declared order, and its `hash` by node's SHA-256, so the bytes
//! are pinned by a second writer.

#![allow(clippy::unwrap_used)]

use std::{fs, path::PathBuf};

use eos_contracts::Blueprint;
use eos_domain::routine::blueprint::{canonical_json, hash};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    /// JSON text, so the numbers keep the spelling they came with.
    input: String,
    canonical: String,
    hash: String,
}

fn vectors() -> Vec<Vector> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/blueprint-vectors.json");
    serde_json::from_slice::<Vectors>(&fs::read(path).unwrap()).unwrap().vectors
}

fn read(text: &str) -> Blueprint {
    eos_contracts::read(&serde_json::from_str(text).unwrap()).unwrap()
}

#[test]
fn each_vector_writes_its_canonical_json_and_hash() {
    let vectors = vectors();
    assert_eq!(vectors.len(), 3);
    for vector in vectors {
        let canonical = canonical_json(&read(&vector.input));
        assert_eq!(canonical, vector.canonical, "{}", vector.name);
        assert_eq!(hash(&canonical), vector.hash, "{}", vector.name);
    }
}

#[test]
fn canonical_json_read_again_writes_the_same_bytes() {
    for vector in vectors() {
        assert_eq!(canonical_json(&read(&vector.canonical)), vector.canonical, "{}", vector.name);
    }
}
