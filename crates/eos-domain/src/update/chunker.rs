//! Content-defined chunking with a gear hash. Where a file is cut is decided by its
//! own bytes, so an edit moves only the cuts around it and the rest of the file still
//! matches the installed copy.
//!
//! Publisher and every installed app must cut identically: the table, the sizes
//! and the masks are part of manifest format 1. This is not FastCDC — the hash,
//! the masks and the size rules are Eos's own. `fixtures/update/chunker-vectors.json`
//! holds what the TypeScript chunker cuts (`tests/update_vectors.rs`).

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

    /// xorshift32 noise, as the TypeScript tests make it.
    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut x = seed.max(1);
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }

    #[test]
    fn every_chunk_stays_within_its_bounds() {
        let data = noise(8 * 1024 * 1024, 11);
        let lengths = chunk_lengths(&data);
        assert_eq!(lengths.iter().sum::<usize>(), data.len());
        let (last, rest) = lengths.split_last().expect("chunks");
        assert!(rest.iter().all(|&l| l > CHUNK_MIN && l <= CHUNK_MAX));
        assert!(*last <= CHUNK_MAX);
        let average = data.len() / lengths.len();
        assert!(average > 2 * CHUNK_MIN && average < CHUNK_MAX / 2, "{average}");
    }

    #[test]
    fn the_cuts_are_the_same_however_the_stream_is_sliced() {
        let data = noise(3 * 1024 * 1024, 7);
        let slices = [1usize, 7, 4096, 100_000, 300_000, 65_536];
        let mut chunker = ContentChunker::new();
        let mut lengths = Vec::new();
        let (mut offset, mut i) = (0, 0);
        while offset < data.len() {
            let end = (offset + slices[i % slices.len()]).min(data.len());
            chunker.push(&data[offset..end], &mut lengths);
            offset = end;
            i += 1;
        }
        lengths.extend(chunker.end());
        assert_eq!(lengths, chunk_lengths(&data));
    }
}
