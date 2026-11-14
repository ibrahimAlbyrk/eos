use std::sync::atomic::{AtomicU64, Ordering};

use eos_core::{Alphabet, Ids};

/// Ids that count up: the first is `…0001`, the next `…0002`, whatever their
/// kind. Every shape of [`Ids`] keeps its prefix and length, so stored rows
/// and the wire normalizer treat them like real ones.
#[derive(Debug, Default)]
pub struct SeqIds(AtomicU64);

impl SeqIds {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Ids for SeqIds {
    fn token(&self, alphabet: Alphabet, len: usize) -> String {
        let chars = alphabet.chars();
        let mut n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        let mut digits = vec![chars[0]; len];
        for slot in digits.iter_mut().rev() {
            *slot = chars[(n % chars.len() as u64) as usize];
            n /= chars.len() as u64;
        }
        digits.into_iter().map(char::from).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_up_in_every_shape() {
        let ids = SeqIds::new();
        assert_eq!(ids.worker_id(), "w-00000001");
        assert_eq!(ids.worker_id(), "w-00000002");
        assert_eq!(ids.page_id(), "pg-000000000003");
        assert_eq!(ids.view_id(), "v_AAAAAAAAAAAE");
        assert_eq!(ids.uuid(), "00000000-0000-4000-8000-000000000005");
        for _ in 0..30 {
            ids.request_id();
        }
        assert_eq!(ids.request_id(), "r-00000010", "base 36");
    }
}
