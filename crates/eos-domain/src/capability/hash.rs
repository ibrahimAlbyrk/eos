//! The hash a capability's package is pinned by at install and checked
//! against before its code runs: SHA-256 over the package's files sorted by
//! their relative path (its UTF-8 bytes, `/` between folders), each written
//! as `path`, a zero byte, its length in decimal ASCII, a zero byte and its
//! bytes; lowercase hex. Vectors: `fixtures/capabilities/hash.json`.

use sha2::{Digest, Sha256};

/// The hash of a package given as `(relative path, bytes)` pairs, in any
/// order.
pub fn package_hash(files: &[(&str, &[u8])]) -> String {
    let mut sorted: Vec<&(&str, &[u8])> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut hasher = Sha256::new();
    for (path, bytes) in sorted {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(bytes.len().to_string().as_bytes());
        hasher.update([0]);
        hasher.update(bytes);
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const VECTORS: &str = include_str!("../../../../fixtures/capabilities/hash.json");

    #[test]
    fn packages_hash_as_the_vectors_say_whatever_order_their_files_come_in() {
        let vectors: Value = serde_json::from_str(VECTORS).expect("hash.json");
        let cases = vectors["cases"].as_array().expect("cases");
        assert!(cases.len() >= 4);
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let files: Vec<(String, Vec<u8>)> = case["files"]
                .as_array()
                .expect("files")
                .iter()
                .map(|file| {
                    let path = file["path"].as_str().expect("path").to_owned();
                    let hex = file["hex"].as_str().expect("hex");
                    (path, hex::decode(hex).expect("hex bytes"))
                })
                .collect();
            let mut given: Vec<(&str, &[u8])> = files.iter().map(|(p, b)| (p.as_str(), b.as_slice())).collect();
            assert_eq!(package_hash(&given), case["hash"].as_str().expect("hash"), "{name}");
            given.reverse();
            assert_eq!(package_hash(&given), case["hash"].as_str().expect("hash"), "{name}, reversed");
        }
    }
}
