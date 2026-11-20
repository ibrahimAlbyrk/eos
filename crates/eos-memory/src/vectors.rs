//! The notes' meaning vectors in memory, for the search by meaning: int8
//! rows with their scale, scanned whole (50,000 × 256 is 12.8 MB, a scan a
//! few milliseconds).

use std::collections::HashMap;

use eos_core::store::StoredVector;

/// Rows the index holds at most: one per live note.
pub const MAX_ROWS: usize = 50_000;
/// Matches the search by meaning offers recall.
pub const MEANING_SEEDS: usize = 32;

/// A vector as stored: int8 values and the scale that brings them back.
pub fn quantize(vector: &[f32]) -> (f32, Vec<i8>) {
    let max = vector.iter().fold(0f32, |m, x| m.max(x.abs()));
    if max == 0.0 {
        return (1.0, vec![0; vector.len()]);
    }
    let scale = max / 127.0;
    (scale, vector.iter().map(|x| (x / scale).round().clamp(-127.0, 127.0) as i8).collect())
}

#[derive(Debug, Default)]
pub struct VectorIndex {
    model: String,
    rows: Vec<StoredVector>,
    /// Each note's place in `rows`.
    at: HashMap<i64, usize>,
}

impl VectorIndex {
    /// The index of `model`'s vectors; vectors of another model are left out.
    pub fn new(model: &str, vectors: Vec<StoredVector>) -> Self {
        let mut index = Self { model: model.to_owned(), rows: Vec::new(), at: HashMap::new() };
        for vector in vectors {
            index.put(vector);
        }
        index
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Adds or replaces a note's vector; past [`MAX_ROWS`] a new one is dropped.
    pub fn put(&mut self, vector: StoredVector) {
        if vector.model != self.model {
            return;
        }
        match self.at.get(&vector.note_rowid) {
            Some(&i) => self.rows[i] = vector,
            None if self.rows.len() < MAX_ROWS => {
                self.at.insert(vector.note_rowid, self.rows.len());
                self.rows.push(vector);
            }
            None => {}
        }
    }

    pub fn remove(&mut self, note_rowid: i64) {
        let Some(i) = self.at.remove(&note_rowid) else { return };
        self.rows.swap_remove(i);
        if let Some(moved) = self.rows.get(i) {
            self.at.insert(moved.note_rowid, i);
        }
    }

    /// How alike two notes' meanings are, by cosine; `None` when either has
    /// no vector.
    pub fn similarity(&self, a: i64, b: i64) -> Option<f64> {
        let (a, b) = (&self.rows[*self.at.get(&a)?], &self.rows[*self.at.get(&b)?]);
        let dot: i64 = a.vec.iter().zip(&b.vec).map(|(&x, &y)| i64::from(x) * i64::from(y)).sum();
        Some(dot as f64 * f64::from(a.scale) * f64::from(b.scale))
    }

    /// The `k` rows most like `query` (unit length), by cosine, best first.
    pub fn nearest(&self, query: &[f32], k: usize) -> Vec<(i64, f64)> {
        let mut scored: Vec<(i64, f64)> = self
            .rows
            .iter()
            .filter(|r| r.vec.len() == query.len())
            .map(|r| {
                let dot: f32 = r.vec.iter().zip(query).map(|(&v, &q)| f32::from(v) * q).sum();
                (r.note_rowid, f64::from(dot * r.scale))
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        scored.truncate(k);
        scored
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: &[f32]) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / n).collect()
    }

    fn row(rowid: i64, model: &str, v: &[f32]) -> StoredVector {
        let (scale, vec) = quantize(&unit(v));
        StoredVector { note_rowid: rowid, model: model.into(), scale, vec }
    }

    #[test]
    fn quantized_vectors_keep_their_direction() {
        let v = unit(&[0.3, -0.9, 0.1, 0.0]);
        let (scale, q) = quantize(&v);
        assert_eq!(q.iter().map(|x| x.unsigned_abs()).max(), Some(127));
        for (x, y) in v.iter().zip(&q) {
            assert!((x - f32::from(*y) * scale).abs() < 0.01);
        }
        assert_eq!(quantize(&[0.0, 0.0]), (1.0, vec![0, 0]));
    }

    #[test]
    fn the_nearest_rows_come_first_and_other_models_stay_out() {
        let index = VectorIndex::new(
            "m",
            vec![
                row(1, "m", &[1.0, 0.0, 0.0]),
                row(2, "m", &[0.7, 0.7, 0.0]),
                row(3, "m", &[0.0, 0.0, 1.0]),
                row(4, "other", &[1.0, 0.0, 0.0]),
            ],
        );
        assert_eq!(index.len(), 3);
        let near = index.nearest(&unit(&[1.0, 0.1, 0.0]), 2);
        assert_eq!(near.iter().map(|n| n.0).collect::<Vec<_>>(), [1, 2]);
        assert!(near[0].1 > 0.98);
        let mut index = index;
        index.put(row(1, "m", &[0.0, 0.0, 1.0]));
        index.remove(3);
        assert_eq!(index.len(), 2);
        assert_eq!(index.nearest(&[0.0, 0.0, 1.0], 1)[0].0, 1, "a put replaces the note's row");
    }
}
