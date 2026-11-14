//! Which artifact views the pool closes.

use std::collections::BTreeSet;
use std::time::Duration;

/// At most this many views stay open beyond the ones on screen.
pub const POOL_CAP: usize = 4;
/// A view nobody placed for this long is closed.
pub const IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolItem<K> {
    pub key: K,
    /// Showing somewhere (a peek or a tab): never closed by the pool.
    pub placed: bool,
    /// How long ago it was last used.
    pub idle: Duration,
}

/// The views to close: unplaced ones idle for `idle_limit`, then the least recently used
/// unplaced ones over `cap`.
pub fn pick_evictions<K: Clone + Ord>(items: &[PoolItem<K>], cap: usize, idle_limit: Duration) -> Vec<K> {
    let mut out: BTreeSet<K> =
        items.iter().filter(|it| !it.placed && it.idle >= idle_limit).map(|it| it.key.clone()).collect();
    let kept: Vec<&PoolItem<K>> = items.iter().filter(|it| !out.contains(&it.key)).collect();
    let over = kept.len().saturating_sub(cap);
    if over > 0 {
        let mut unplaced: Vec<&&PoolItem<K>> = kept.iter().filter(|it| !it.placed).collect();
        // Least recently used first: the longest idle.
        unplaced.sort_by_key(|it| std::cmp::Reverse(it.idle));
        out.extend(unplaced.into_iter().take(over).map(|it| it.key.clone()));
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, placed: bool, idle_s: u64) -> PoolItem<String> {
        PoolItem { key: key.into(), placed, idle: Duration::from_secs(idle_s) }
    }

    #[test]
    fn closes_idle_unplaced_views_then_the_least_recent_over_the_cap() {
        let items = [
            item("a", false, 400),
            item("b", true, 900),
            item("c", false, 10),
            item("d", false, 20),
            item("e", false, 30),
            item("f", false, 5),
            item("g", true, 1),
        ];
        // `a` is idle; six remain for four places: the two longest idle unplaced go.
        assert_eq!(pick_evictions(&items, 4, IDLE), ["a", "d", "e"]);
    }

    #[test]
    fn placed_views_are_never_closed_even_over_the_cap() {
        let items: Vec<_> = (0..6).map(|n| item(&n.to_string(), true, 9_999)).collect();
        assert!(pick_evictions(&items, 4, IDLE).is_empty());
        assert!(pick_evictions(&[item("x", false, 299)], 4, IDLE).is_empty());
    }
}
