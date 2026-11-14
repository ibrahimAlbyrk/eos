//! One kept piece of a working tree's state: its generation, its value, and
//! the one computation that brings it up to date.
//!
//! The generation changes on every invalidation. A computation remembers
//! the generation it started at: its result goes to everyone who waited for
//! it, but is kept only if no invalidation came in between. Callers after an
//! invalidation never join a computation started before it.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::OnceCell;
use tokio::time::Instant;

/// A computation callers share; the first caller to poll it runs it, and if
/// that caller goes away the next one takes over.
pub(super) type Flight<T> = Arc<OnceCell<Arc<T>>>;

pub(super) struct Part<T> {
    generation: u64,
    /// The value and when the computation that made it started.
    kept: Option<(Arc<T>, Instant)>,
    flight: Option<(u64, Flight<T>)>,
    read_at: Option<Instant>,
}

/// What a caller gets: the kept value, or the computation to wait for.
pub(super) enum Ask<T> {
    Kept(Arc<T>),
    Wait { generation: u64, flight: Flight<T> },
}

impl<T> Part<T> {
    pub(super) fn new(generation: u64) -> Self {
        Self { generation, kept: None, flight: None, read_at: None }
    }

    /// The kept value if it is younger than `max_age` says for it, else the
    /// computation of the current generation (started now if none runs).
    pub(super) fn ask(&mut self, now: Instant, max_age: impl FnOnce(&T) -> Duration) -> Ask<T> {
        self.read_at = Some(now);
        if let Some((value, at)) = &self.kept
            && now.saturating_duration_since(*at) < max_age(value)
        {
            return Ask::Kept(value.clone());
        }
        let generation = self.generation;
        let flight = match &self.flight {
            Some((started_at, flight)) if *started_at == generation => flight.clone(),
            _ => {
                let flight: Flight<T> = Arc::default();
                self.flight = Some((generation, flight.clone()));
                flight
            }
        };
        Ask::Wait { generation, flight }
    }

    /// A computation of `flight`, started at `generation` and at `started`,
    /// ended with `value`. `keep` false: hand it out, keep nothing.
    pub(super) fn settle(&mut self, generation: u64, flight: &Flight<T>, value: Arc<T>, started: Instant, keep: bool) {
        if self.flight.as_ref().is_some_and(|(_, running)| Arc::ptr_eq(running, flight)) {
            self.flight = None;
        }
        if keep && generation == self.generation {
            self.kept = Some((value, started));
        }
    }

    /// Whatever is kept is stale; `generation` is a number never used before.
    pub(super) fn invalidate(&mut self, generation: u64) {
        self.generation = generation;
        self.kept = None;
    }

    /// Somebody read it within `window` and nothing fresh is kept.
    pub(super) fn wants_refresh(&self, now: Instant, window: Duration) -> bool {
        self.kept.is_none() && self.read_at.is_some_and(|at| now.saturating_duration_since(at) < window)
    }

    pub(super) fn read_at(&self) -> Option<Instant> {
        self.read_at
    }

    pub(super) fn kept(&self) -> Option<&Arc<T>> {
        self.kept.as_ref().map(|(value, _)| value)
    }

    /// Drops the kept value (to make room), leaving the generation as it is.
    pub(super) fn forget(&mut self) {
        self.kept = None;
    }
}

/// Parts of one kind told apart by a key (a base, a revision); at most `max`
/// of them, the one read longest ago making room.
pub(super) struct Keyed<T> {
    max: usize,
    entries: Vec<(String, Part<T>)>,
}

impl<T> Keyed<T> {
    pub(super) fn new(max: usize) -> Self {
        Self { max: max.max(1), entries: Vec::new() }
    }

    /// The part for `key`, made (at a new generation) when missing.
    pub(super) fn entry(&mut self, key: &str, generation: impl FnOnce() -> u64) -> &mut Part<T> {
        if let Some(at) = self.entries.iter().position(|(k, _)| k == key) {
            return &mut self.entries[at].1;
        }
        if self.entries.len() >= self.max
            && let Some(oldest) = (0..self.entries.len()).min_by_key(|&i| self.entries[i].1.read_at())
        {
            self.entries.swap_remove(oldest);
        }
        self.entries.push((key.to_owned(), Part::new(generation())));
        let last = self.entries.len() - 1;
        &mut self.entries[last].1
    }

    pub(super) fn get_mut(&mut self, key: &str) -> Option<&mut Part<T>> {
        self.entries.iter_mut().find(|(k, _)| k == key).map(|(_, part)| part)
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = (&str, &Part<T>)> {
        self.entries.iter().map(|(key, part)| (key.as_str(), part))
    }

    pub(super) fn iter_mut(&mut self) -> impl Iterator<Item = (&str, &mut Part<T>)> {
        self.entries.iter_mut().map(|(key, part)| (key.as_str(), part))
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flight_of(ask: Ask<u32>) -> (u64, Flight<u32>) {
        match ask {
            Ask::Wait { generation, flight } => (generation, flight),
            Ask::Kept(_) => panic!("nothing should be kept"),
        }
    }

    #[test]
    fn callers_share_one_computation_and_its_result_is_kept() {
        let (now, age) = (Instant::now(), Duration::from_secs(30));
        let mut part = Part::<u32>::new(1);
        let (generation, first) = flight_of(part.ask(now, |_| age));
        let (_, second) = flight_of(part.ask(now, |_| age));
        assert!(Arc::ptr_eq(&first, &second));
        part.settle(generation, &first, Arc::new(7), now, true);
        assert!(matches!(part.ask(now, |_| age), Ask::Kept(v) if *v == 7));
        // Too old: computed again.
        assert!(matches!(part.ask(now + age, |_| age), Ask::Wait { .. }));
    }

    #[test]
    fn a_result_started_before_an_invalidation_is_handed_out_but_not_kept() {
        let (now, age) = (Instant::now(), Duration::from_secs(30));
        let mut part = Part::<u32>::new(1);
        let (generation, old) = flight_of(part.ask(now, |_| age));
        part.invalidate(2);
        // A caller after the invalidation does not join the old computation.
        let (newer, fresh) = flight_of(part.ask(now, |_| age));
        assert!(!Arc::ptr_eq(&old, &fresh));
        assert_eq!(newer, 2);
        part.settle(generation, &old, Arc::new(1), now, true);
        assert!(matches!(part.ask(now, |_| age), Ask::Wait { .. }));
        part.settle(newer, &fresh, Arc::new(2), now, true);
        assert!(matches!(part.ask(now, |_| age), Ask::Kept(v) if *v == 2));
    }

    #[test]
    fn keyed_parts_are_bounded_by_the_oldest_read() {
        let now = Instant::now();
        let mut keyed = Keyed::<u32>::new(2);
        let mut next = 0;
        let mut generation = || {
            next += 1;
            next
        };
        keyed.entry("a", &mut generation).ask(now, |_| Duration::ZERO);
        keyed.entry("b", &mut generation).ask(now + Duration::from_secs(1), |_| Duration::ZERO);
        keyed.entry("a", &mut generation).ask(now + Duration::from_secs(2), |_| Duration::ZERO);
        keyed.entry("c", &mut generation);
        let keys: Vec<&str> = keyed.iter().map(|(k, _)| k).collect();
        assert_eq!((keyed.len(), keys.contains(&"b")), (2, false));
    }
}
