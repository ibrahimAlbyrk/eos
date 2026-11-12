//! The rows of one buffer, oldest first, with a cap: adding past it drops
//! the oldest (`common/CircularList.ts`).

use std::collections::VecDeque;

use super::line::Line;

#[derive(Debug, Clone, Default)]
pub(super) struct Lines {
    items: VecDeque<Line>,
    max: usize,
    /// Where xterm's ring would start. Rows are not stored in a ring here,
    /// but one thing shows where it starts: a write just below index 0 lands
    /// on the last rows once the ring has turned (see [`Lines::wrapped_index`]).
    start: usize,
}

impl Lines {
    pub(super) fn new(max: usize) -> Self {
        Self { items: VecDeque::new(), max, start: 0 }
    }

    pub(super) fn len(&self) -> isize {
        self.items.len() as isize
    }

    pub(super) fn max_len(&self) -> isize {
        self.max as isize
    }

    /// The cap only moves here; the caller trims first when it shrinks.
    pub(super) fn set_max_len(&mut self, max: usize) {
        if max != self.max {
            self.start = 0;
        }
        self.max = max;
        self.items.truncate(max);
    }

    pub(super) fn is_full(&self) -> bool {
        self.items.len() == self.max
    }

    pub(super) fn get(&self, index: isize) -> Option<&Line> {
        usize::try_from(index).ok().and_then(|i| self.items.get(i))
    }

    pub(super) fn get_mut(&mut self, index: isize) -> Option<&mut Line> {
        usize::try_from(index).ok().and_then(|i| self.items.get_mut(i))
    }

    /// Adds a row at the end; `true` when the oldest row was dropped for it.
    pub(super) fn push(&mut self, line: Line) -> bool {
        let trimmed = self.is_full() && self.items.pop_front().is_some();
        if trimmed {
            self.start = (self.start + 1) % self.max.max(1);
        }
        self.items.push_back(line);
        trimmed
    }

    pub(super) fn pop(&mut self) -> Option<Line> {
        self.items.pop_back()
    }

    pub(super) fn remove(&mut self, index: isize) -> Option<Line> {
        usize::try_from(index).ok().and_then(|i| self.items.remove(i))
    }

    /// Puts a row at `index`; rows past the cap fall off the front.
    pub(super) fn insert(&mut self, index: isize, line: Line) {
        let Ok(index) = usize::try_from(index) else { return };
        if index > self.items.len() {
            return;
        }
        self.items.insert(index, line);
        while self.items.len() > self.max {
            self.items.pop_front();
            self.start += 1;
        }
    }

    pub(super) fn trim_start(&mut self, count: isize) {
        let count = usize::try_from(count).unwrap_or(0).min(self.items.len());
        self.items.drain(..count);
        self.start += count;
    }

    /// The row a write at `index` below zero lands on in xterm's ring: none
    /// while the ring has not turned that far, else a row counted from the end.
    pub(super) fn wrapped_index(&self, index: isize) -> Option<isize> {
        let max = self.max as isize;
        (index < 0 && max > 0 && self.start as isize + index >= 0).then(|| index.rem_euclid(max))
    }

    /// Every row, taken out: the caller rebuilds the list (a reflow).
    pub(super) fn take_all(&mut self) -> Vec<Line> {
        self.items.drain(..).collect()
    }

    pub(super) fn replace_all(&mut self, lines: impl IntoIterator<Item = Line>) {
        self.items = lines.into_iter().collect();
    }

    pub(super) fn iter_mut(&mut self) -> impl Iterator<Item = &mut Line> {
        self.items.iter_mut()
    }
}
