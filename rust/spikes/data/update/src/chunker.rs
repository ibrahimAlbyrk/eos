//! Content-defined chunking with a gear hash. Publisher and every installed app
//! must cut identically: the table, the sizes and the masks are part of manifest
//! format 1. This is not FastCDC — the hash, the masks and the size rules are
//! Eos's own.

use sha2::{Digest, Sha256};

pub const CHUNK_MIN: usize = 16 * 1024;
pub const CHUNK_AVG: usize = 64 * 1024;
pub const CHUNK_MAX: usize = 256 * 1024;

// A stricter mask before the average size and a looser one after it. They test
// the hash's high bits, which depend on the last 32 bytes.
const MASK_STRICT: u32 = 0xffff_8000; // 17 bits
const MASK_LOOSE: u32 = 0xfffe_0000; // 15 bits

/// xorshift32 from 0x9e3779b9, one step per entry.
const GEAR: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut x: u32 = 0x9e37_79b9;
    let mut i = 0;
    while i < 256 {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        table[i] = x;
        i += 1;
    }
    table
};

/// Cuts a byte stream fed in slices of any size.
#[derive(Debug, Default, Clone)]
pub struct ContentChunker {
    hash: u32,
    length: usize,
}

impl ContentChunker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends to `cuts` the lengths of the chunks that ended inside `data`.
    pub fn push(&mut self, data: &[u8], cuts: &mut Vec<usize>) {
        let (mut hash, mut length) = (self.hash, self.length);
        for &byte in data {
            length += 1;
            // The first CHUNK_MIN bytes of a chunk never enter the hash.
            if length <= CHUNK_MIN {
                continue;
            }
            hash = (hash << 1).wrapping_add(GEAR[byte as usize]);
            let mask = if length <= CHUNK_AVG { MASK_STRICT } else { MASK_LOOSE };
            if hash & mask != 0 && length < CHUNK_MAX {
                continue;
            }
            cuts.push(length);
            length = 0;
            hash = 0;
        }
        self.hash = hash;
        self.length = length;
    }

    /// The length of the last chunk, if the stream did not end on a cut.
    pub fn end(&mut self) -> Option<usize> {
        let last = std::mem::take(&mut self.length);
        self.hash = 0;
        (last > 0).then_some(last)
    }
}

pub fn chunk_lengths(data: &[u8]) -> Vec<usize> {
    let mut chunker = ContentChunker::new();
    let mut lengths = Vec::new();
    chunker.push(data, &mut lengths);
    lengths.extend(chunker.end());
    lengths
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedChunk {
    /// sha256 of the chunk's bytes, lowercase hex.
    pub id: String,
    pub offset: u64,
    pub size: usize,
}

/// A file as the feed describes it: hashed whole and cut into chunks.
pub fn scan(data: &[u8]) -> (String, Vec<ScannedChunk>) {
    let mut offset = 0usize;
    let chunks = chunk_lengths(data)
        .into_iter()
        .map(|size| {
            let id = hex::encode(Sha256::digest(&data[offset..offset + size]));
            let chunk = ScannedChunk { id, offset: offset as u64, size };
            offset += size;
            chunk
        })
        .collect();
    (hex::encode(Sha256::digest(data)), chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gear_table_starts_and_ends_as_in_typescript() {
        // First and last entries printed by the TypeScript table builder.
        assert_eq!(GEAR[0], 0x510c_4619);
        assert_eq!(GEAR[255], 0xef58_8093);
    }

    #[test]
    fn nothing_in_nothing_out() {
        assert!(chunk_lengths(&[]).is_empty());
        assert_eq!(chunk_lengths(&[7]), vec![1]);
    }

    #[test]
    fn no_chunk_is_longer_than_max_and_only_the_last_is_shorter_than_min() {
        let data = crate::testgen::random_bytes("bounds", 3_000_000);
        let lengths = chunk_lengths(&data);
        assert_eq!(lengths.iter().sum::<usize>(), data.len());
        let (last, rest) = lengths.split_last().unwrap();
        assert!(rest.iter().all(|&l| l > CHUNK_MIN && l <= CHUNK_MAX));
        assert!(*last <= CHUNK_MAX);
    }
}
