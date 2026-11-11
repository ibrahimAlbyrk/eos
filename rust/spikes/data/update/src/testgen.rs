//! Deterministic inputs shared with the TypeScript side (ts/gen.ts): the
//! fixtures name a generator instead of carrying megabytes of input.

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// SHA-256 in counter mode over `"<seed>:<i>"`.
pub fn random_bytes(seed: &str, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut i = 0u64;
    while out.len() < len {
        out.extend_from_slice(&Sha256::digest(format!("{seed}:{i}")));
        i += 1;
    }
    out.truncate(len);
    out
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Gen {
    Random { seed: String, len: usize },
    Zeros { len: usize },
    Repeat { seed: String, block: usize, len: usize },
    Drift { seed: String, block: usize, every: usize, len: usize },
    Text { len: usize, tag: Option<String> },
}

pub fn generate(g: &Gen) -> Vec<u8> {
    match g {
        Gen::Random { seed, len } => random_bytes(seed, *len),
        Gen::Zeros { len } => vec![0; *len],
        Gen::Repeat { seed, block, len } => random_bytes(seed, *block).iter().copied().cycle().take(*len).collect(),
        Gen::Drift { seed, block, every, len } => {
            let b = random_bytes(seed, *block);
            (0..*len)
                .map(|at| if at % every == 0 { b[at % block].wrapping_add((at / block) as u8) } else { b[at % block] })
                .collect()
        }
        Gen::Text { len, tag } => {
            let tag = tag.as_deref().unwrap_or("line");
            let mut out = Vec::with_capacity(len + 64);
            let mut i = 0u64;
            while out.len() < *len {
                out.extend_from_slice(format!("{tag} {i}: the quick brown fox jumps over the lazy dog\n").as_bytes());
                i += 1;
            }
            out.truncate(*len);
            out
        }
    }
}
