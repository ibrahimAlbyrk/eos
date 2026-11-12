//! One screen with its history: the normal buffer (with scrollback) or the
//! alternate one (`common/buffer/Buffer.ts`, `BufferReflow.ts`, and the
//! scrolling half of `BufferService.ts`).

use std::collections::{BTreeMap, BTreeSet};

use super::attrs::Attr;
use super::charsets::Charset;
use super::line::{CellData, Line};
use super::lines::Lines;

/// xterm.js's default scrollback — what the clients keep, too.
pub(super) const SCROLLBACK: isize = 1000;
const TAB_WIDTH: usize = 8;

#[derive(Debug, Clone)]
pub(super) struct Buffer {
    pub(super) lines: Lines,
    /// Index of the row at the top of the screen.
    pub(super) ybase: isize,
    /// The cursor, relative to the screen. `x` may equal the width: the
    /// cursor then waits past the last column until the next character wraps.
    pub(super) x: isize,
    pub(super) y: isize,
    pub(super) scroll_top: isize,
    pub(super) scroll_bottom: isize,
    pub(super) tabs: BTreeSet<isize>,
    pub(super) saved_x: isize,
    pub(super) saved_y: isize,
    /// The saved pen: `fg` and `bg` only, as xterm saves it.
    pub(super) saved_fg: u32,
    pub(super) saved_bg: u32,
    pub(super) saved_charset: Option<Charset>,
    cols: isize,
    rows: isize,
    has_scrollback: bool,
}

fn blank(attr: Attr) -> CellData {
    CellData::empty(attr)
}

impl Buffer {
    pub(super) fn new(has_scrollback: bool, cols: isize, rows: isize) -> Self {
        let mut buffer = Self {
            lines: Lines::new(0),
            ybase: 0,
            x: 0,
            y: 0,
            scroll_top: 0,
            scroll_bottom: rows - 1,
            tabs: BTreeSet::new(),
            saved_x: 0,
            saved_y: 0,
            saved_fg: 0,
            saved_bg: 0,
            saved_charset: None,
            cols,
            rows,
            has_scrollback,
        };
        buffer.lines = Lines::new(buffer.capacity(rows));
        buffer.setup_tab_stops(None);
        buffer
    }

    fn capacity(&self, rows: isize) -> usize {
        usize::try_from(if self.has_scrollback { rows + SCROLLBACK } else { rows }).unwrap_or(0)
    }

    /// Gives an empty buffer its screenful of rows.
    pub(super) fn fill_viewport_rows(&mut self, attr: Attr, term_cols: isize) {
        if self.lines.len() == 0 {
            for _ in 0..self.rows {
                self.lines.push(blank_line(term_cols, attr, false));
            }
        }
    }

    /// Empties the buffer (the alternate screen on leaving it).
    pub(super) fn clear(&mut self) {
        self.ybase = 0;
        self.y = 0;
        self.x = 0;
        self.lines = Lines::new(self.capacity(self.rows));
        self.scroll_top = 0;
        self.scroll_bottom = self.rows - 1;
        self.setup_tab_stops(None);
    }

    pub(super) fn line(&self, y: isize) -> Option<&Line> {
        self.lines.get(self.ybase + y)
    }

    pub(super) fn line_mut(&mut self, y: isize) -> Option<&mut Line> {
        self.lines.get_mut(self.ybase + y)
    }

    /// Scrolls the scroll region up by one row; the new bottom row is erased
    /// with `erase`. A region that starts at the top feeds the scrollback.
    pub(super) fn scroll(&mut self, erase: Attr, wrapped: bool, term_cols: isize) {
        let new_line = blank_line(term_cols, erase, wrapped);
        let top = self.ybase + self.scroll_top;
        let bottom = self.ybase + self.scroll_bottom;
        if self.scroll_top == 0 {
            let will_trim = self.lines.is_full();
            if bottom == self.lines.len() - 1 {
                self.lines.push(new_line);
            } else {
                self.lines.insert(bottom + 1, new_line);
            }
            if !will_trim {
                self.ybase += 1;
            }
        } else if self.lines.remove(top).is_some() {
            self.lines.insert(bottom, new_line);
        }
    }

    pub(super) fn resize(&mut self, new_cols: isize, new_rows: isize) {
        let null = blank(Attr::default());
        let new_max = self.capacity(new_rows);
        if new_max as isize > self.lines.max_len() {
            self.lines.set_max_len(new_max);
        }

        if self.lines.len() > 0 {
            if self.cols < new_cols {
                for line in self.lines.iter_mut() {
                    line.resize(new_cols as usize, &null);
                }
            }

            let mut add_to_y = 0;
            if self.rows < new_rows {
                for _ in self.rows..new_rows {
                    if self.lines.len() < new_rows + self.ybase {
                        if self.ybase > 0 && self.lines.len() <= self.ybase + self.y + add_to_y + 1 {
                            // Nothing below the cursor: pull a row back out of the scrollback.
                            self.ybase -= 1;
                            add_to_y += 1;
                        } else if self.lines.push(Line::new(new_cols as usize, &null, false)) {
                            // The list was full and its oldest row went. xterm
                            // leaves the screen's top where it was, which puts
                            // the last rows past the end of its ring (they wrap
                            // onto the first ones and a snapshot comes out
                            // shuffled). Deliberately not copied: the screen
                            // moves up with its rows.
                            self.ybase = (self.ybase - 1).max(0);
                        }
                    }
                }
            } else {
                for _ in new_rows..self.rows {
                    if self.lines.len() > new_rows + self.ybase {
                        if self.lines.len() > self.ybase + self.y + 1 {
                            self.lines.pop();
                        } else {
                            self.ybase += 1;
                        }
                    }
                }
            }

            if (new_max as isize) < self.lines.max_len() {
                let trim = self.lines.len() - new_max as isize;
                if trim > 0 {
                    self.lines.trim_start(trim);
                    self.ybase = (self.ybase - trim).max(0);
                    self.saved_y = (self.saved_y - trim).max(0);
                }
                self.lines.set_max_len(new_max);
            }

            self.x = self.x.min(new_cols - 1);
            self.y = self.y.min(new_rows - 1);
            self.y += add_to_y;
            self.saved_x = self.saved_x.min(new_cols - 1);
            self.scroll_top = 0;
        }

        self.scroll_bottom = new_rows - 1;

        // Only the buffer with a history re-wraps its rows; the alternate
        // screen keeps rows at the width they had (xterm does not cut them).
        if self.has_scrollback {
            if self.cols != new_cols {
                if new_cols > self.cols {
                    self.reflow_larger(new_cols, new_rows);
                } else {
                    self.reflow_smaller(new_cols, new_rows);
                }
            }
            if self.cols > new_cols {
                for line in self.lines.iter_mut() {
                    line.resize(new_cols as usize, &null);
                }
            }
        }

        self.cols = new_cols;
        self.rows = new_rows;
    }

    fn reflow_larger(&mut self, new_cols: isize, new_rows: isize) {
        let null = blank(Attr::default());
        let mut all = self.lines.take_all();
        let to_remove = lines_to_remove(&mut all, self.cols, new_cols, self.ybase + self.y, &null);
        if to_remove.is_empty() {
            self.lines.replace_all(all);
            return;
        }
        let mut removed = 0;
        let mut ranges = to_remove.iter().peekable();
        let mut kept = Vec::with_capacity(all.len());
        let mut skip = 0;
        for (i, line) in all.into_iter().enumerate() {
            if let Some(&&(start, count)) = ranges.peek()
                && start == i as isize
            {
                skip = count;
                removed += count;
                ranges.next();
            }
            if skip > 0 {
                skip -= 1;
            } else {
                kept.push(line);
            }
        }
        self.lines.replace_all(kept);

        for _ in 0..removed {
            if self.ybase == 0 {
                if self.y > 0 {
                    self.y -= 1;
                }
                if self.lines.len() < new_rows {
                    self.lines.push(Line::new(new_cols as usize, &null, false));
                }
            } else {
                self.ybase -= 1;
            }
        }
        self.saved_y = (self.saved_y - removed).max(0);
    }

    fn reflow_smaller(&mut self, new_cols: isize, new_rows: isize) {
        let null = blank(Attr::default());
        let old_cols = self.cols;
        // Groups of new rows, bottom-most group first: (index to insert at, rows).
        let mut to_insert: Vec<(isize, Vec<Line>)> = Vec::new();
        let mut count_to_insert: isize = 0;

        // xterm's list keeps a row it popped readable at its old index, and
        // this loop, walking up from the old end, still meets such rows and
        // re-wraps them as if they were there. They are kept aside to do the same.
        let mut popped: BTreeMap<isize, Line> = BTreeMap::new();

        let mut y = self.lines.len() - 1;
        while y >= 0 {
            let Some(line) = self.lines.get(y).or_else(|| popped.get(&y)) else {
                y -= 1;
                continue;
            };
            if !line.wrapped && line.trimmed_len() <= new_cols {
                y -= 1;
                continue;
            }
            // The whole wrapped row this line ends: from its first line (y) down.
            let mut count: isize = 1;
            while y > 0 && self.lines.get(y).or_else(|| popped.get(&y)).is_some_and(|l| l.wrapped) {
                y -= 1;
                count += 1;
            }
            // The row the cursor is on stays as it is.
            let cursor = self.ybase + self.y;
            if cursor >= y && cursor < y + count {
                y -= 1;
                continue;
            }

            let mut wrapped: Vec<Line> = (y..y + count)
                .map(|i| match self.lines.get_mut(i) {
                    Some(line) => std::mem::take(line),
                    None => popped.remove(&i).unwrap_or_default(),
                })
                .collect();
            let last_len = wrapped.last().map_or(0, Line::trimmed_len);
            let dest_lens = new_line_lengths(&wrapped, old_cols, new_cols);
            let lines_to_add = dest_lens.len() as isize - count;
            let trimmed = if self.ybase == 0 && self.y != self.lines.len() - 1 {
                (self.y - self.lines.max_len() + lines_to_add).max(0)
            } else {
                (self.lines.len() - self.lines.max_len() + lines_to_add).max(0)
            };
            for _ in 0..lines_to_add {
                wrapped.push(blank_line(new_cols, Attr::default(), true));
            }

            // Fill from the end, so no cell is overwritten before it is read.
            let dest_len = |i: isize| usize::try_from(i).ok().and_then(|i| dest_lens.get(i)).copied();
            let mut dest_index = dest_lens.len() as isize - 1;
            let mut dest_col = dest_len(dest_index);
            if dest_col == Some(0) {
                dest_index -= 1;
                dest_col = dest_len(dest_index);
            }
            let mut src_index = wrapped.len() as isize - lines_to_add - 1;
            let mut src_col = last_len;
            while src_index >= 0 {
                let (Some(col), Ok(dest)) = (dest_col, usize::try_from(dest_index)) else { break };
                if dest >= wrapped.len() || src_index as usize >= wrapped.len() {
                    break;
                }
                let cells = src_col.min(col);
                copy_cells(&mut wrapped, dest, src_index as usize, src_col - cells, col - cells, cells, true);
                dest_col = Some(col - cells);
                if dest_col == Some(0) {
                    dest_index -= 1;
                    dest_col = dest_len(dest_index);
                }
                src_col -= cells;
                if src_col == 0 {
                    src_index -= 1;
                    src_col = wrapped_trimmed_len(&wrapped, src_index.max(0) as usize, old_cols);
                }
            }
            for (i, line) in wrapped.iter_mut().enumerate() {
                if let Some(len) = dest_lens.get(i)
                    && *len < new_cols
                {
                    line.set_cell(*len, &null);
                }
            }

            // The rows that existed go back where they were; the new ones wait.
            let added = wrapped.split_off((count as usize).min(wrapped.len()));
            for (i, line) in wrapped.into_iter().enumerate() {
                let at = y + i as isize;
                match self.lines.get_mut(at) {
                    Some(slot) => *slot = line,
                    None => {
                        popped.insert(at, line);
                    }
                }
            }
            if !added.is_empty() {
                to_insert.push((y + count + count_to_insert, added));
                count_to_insert += lines_to_add;
            }

            for _ in 0..(lines_to_add - trimmed).max(0) {
                if self.ybase == 0 {
                    if self.y < new_rows - 1 {
                        self.y += 1;
                        if let Some(line) = self.lines.pop() {
                            popped.insert(self.lines.len(), line);
                        }
                    } else {
                        self.ybase += 1;
                    }
                } else if self.ybase < self.lines.max_len().min(self.lines.len() + count_to_insert) - new_rows {
                    self.ybase += 1;
                }
            }
            self.saved_y = (self.saved_y + lines_to_add).min(self.ybase + new_rows - 1);
            y -= 1;
        }

        if to_insert.is_empty() {
            return;
        }
        // Rebuild from the end: the oldest rows fall off when the cap is reached.
        let mut originals: Vec<Option<Line>> = self.lines.take_all().into_iter().map(Some).collect();
        let original_len = originals.len() as isize;
        let max = self.lines.max_len();
        let new_len = max.min(original_len + count_to_insert);
        let mut rebuilt: Vec<Option<Line>> = (0..new_len).map(|_| None).collect();
        // More rows than fit: the walk runs below index 0, which the ring
        // turns into the last rows again (they are overwritten, as in xterm).
        let below_zero: Vec<Option<isize>> = (1..=count_to_insert).map(|n| self.lines.wrapped_index(-n)).collect();
        let mut put = |i: isize, line: Option<Line>| {
            let at = if i < 0 { below_zero.get((-i - 1) as usize).copied().flatten() } else { Some(i) };
            if let Some(slot) = at.and_then(|i| usize::try_from(i).ok()).and_then(|i| rebuilt.get_mut(i)) {
                *slot = line;
            }
        };
        let mut original_index = original_len - 1;
        let mut groups = to_insert.into_iter().peekable();
        let mut inserted: isize = 0;
        let mut i = (max - 1).min(original_len + count_to_insert - 1);
        while i >= 0 {
            if let Some((start, _)) = groups.peek()
                && *start > original_index + inserted
            {
                let (_, lines) = groups.next().unwrap_or_default();
                inserted += lines.len() as isize;
                for line in lines.into_iter().rev() {
                    put(i, Some(line));
                    i -= 1;
                }
                i += 1;
            } else {
                let line =
                    usize::try_from(original_index).ok().and_then(|at| originals.get_mut(at)).and_then(Option::take);
                put(i, line);
                original_index -= 1;
            }
            i -= 1;
        }
        self.lines.replace_all(rebuilt.into_iter().map(Option::unwrap_or_default));
    }

    /// Tab stops every eight columns: all of them (`None`), or continued
    /// from the stop at or before `from` (after a resize).
    pub(super) fn setup_tab_stops(&mut self, from: Option<isize>) {
        let mut i = match from {
            Some(i) if self.tabs.contains(&i) => i,
            Some(i) => self.prev_stop(Some(i)),
            None => {
                self.tabs.clear();
                0
            }
        };
        while i < self.cols {
            self.tabs.insert(i);
            i += TAB_WIDTH as isize;
        }
    }

    pub(super) fn prev_stop(&self, from: Option<isize>) -> isize {
        let mut x = from.unwrap_or(self.x);
        loop {
            x -= 1;
            if self.tabs.contains(&x) || x <= 0 {
                break;
            }
        }
        if x >= self.cols { self.cols - 1 } else { x.max(0) }
    }

    pub(super) fn next_stop(&self, from: Option<isize>) -> isize {
        let mut x = from.unwrap_or(self.x);
        loop {
            x += 1;
            if self.tabs.contains(&x) || x >= self.cols {
                break;
            }
        }
        if x >= self.cols { self.cols - 1 } else { x.max(0) }
    }
}

pub(super) fn blank_line(cols: isize, attr: Attr, wrapped: bool) -> Line {
    Line::new(usize::try_from(cols).unwrap_or(0), &blank(attr), wrapped)
}

/// Copies cells between two rows of `lines`, which may be the same row.
fn copy_cells(
    lines: &mut [Line],
    dest: usize,
    src: usize,
    src_col: isize,
    dest_col: isize,
    count: isize,
    reverse: bool,
) {
    if dest == src {
        lines[dest].copy_cells_within(src_col, dest_col, count, reverse);
        return;
    }
    let mut target = std::mem::take(&mut lines[dest]);
    target.copy_cells_from(&lines[src], src_col, dest_col, count, reverse);
    lines[dest] = target;
}

/// How much of a wrapped row's line `i` is text: all of it, unless the next
/// line starts with a wide character that did not fit.
fn wrapped_trimmed_len(lines: &[Line], i: usize, cols: isize) -> isize {
    let Some(line) = lines.get(i) else { return 0 };
    let Some(next) = lines.get(i + 1) else { return line.trimmed_len() };
    let ends_in_null = !line.has_content(cols - 1) && line.width(cols - 1) == 1;
    if ends_in_null && next.width(0) == 2 { cols - 1 } else { cols }
}

/// The lengths of the lines a wrapped row takes at `new_cols`.
fn new_line_lengths(wrapped: &[Line], old_cols: isize, new_cols: isize) -> Vec<isize> {
    let needed: isize = (0..wrapped.len()).map(|i| wrapped_trimmed_len(wrapped, i, old_cols)).sum();
    let mut lengths = Vec::new();
    let (mut src_col, mut src_line, mut available) = (0isize, 0usize, 0isize);
    while available < needed {
        if needed - available < new_cols {
            lengths.push(needed - available);
            break;
        }
        src_col += new_cols;
        let old_len = wrapped_trimmed_len(wrapped, src_line, old_cols);
        if src_col > old_len {
            src_col -= old_len;
            src_line += 1;
        }
        let ends_with_wide = wrapped.get(src_line).is_some_and(|l| l.width(src_col - 1) == 2);
        if ends_with_wide {
            src_col -= 1;
        }
        let len = if ends_with_wide { new_cols - 1 } else { new_cols };
        lengths.push(len);
        available += len;
    }
    lengths
}

/// Widening: pulls the text of wrapped rows up into the room that opened,
/// and names the rows left empty as `(first, count)`, in order.
fn lines_to_remove(
    lines: &mut [Line],
    old_cols: isize,
    new_cols: isize,
    cursor: isize,
    null: &CellData,
) -> Vec<(isize, isize)> {
    let mut to_remove = Vec::new();
    let total = lines.len() as isize;
    let mut y: isize = 0;
    while y < total - 1 {
        let mut i = y + 1;
        if !lines[i as usize].wrapped {
            y += 1;
            continue;
        }
        while i < total && lines[i as usize].wrapped {
            i += 1;
        }
        let count = i - y;
        // The row the cursor is on stays as it is.
        if cursor >= y && cursor < i {
            y += count;
            continue;
        }

        let wrapped = &mut lines[y as usize..i as usize];
        let mut dest = 0usize;
        let mut dest_col = wrapped_trimmed_len(wrapped, dest, old_cols);
        let mut src = 1usize;
        let mut src_col: isize = 0;
        while src < wrapped.len() && dest < wrapped.len() {
            let src_len = wrapped_trimmed_len(wrapped, src, old_cols);
            let cells = (src_len - src_col).min(new_cols - dest_col);
            copy_cells(wrapped, dest, src, src_col, dest_col, cells, false);
            dest_col += cells;
            if dest_col == new_cols {
                dest += 1;
                dest_col = 0;
            }
            src_col += cells;
            if src_col == src_len {
                src += 1;
                src_col = 0;
            }
            // A wide character may not be cut in two at the new margin.
            if dest_col == 0 && dest != 0 && dest < wrapped.len() && wrapped[dest - 1].width(new_cols - 1) == 2 {
                copy_cells(wrapped, dest, dest - 1, new_cols - 1, dest_col, 1, false);
                dest_col += 1;
                wrapped[dest - 1].set_cell(new_cols - 1, null);
            }
        }
        if let Some(line) = wrapped.get_mut(dest) {
            line.replace_cells(dest_col, new_cols, null, false);
        }

        let mut count_to_remove = 0;
        for k in (1..wrapped.len()).rev() {
            if k > dest || wrapped[k].trimmed_len() == 0 {
                count_to_remove += 1;
            } else {
                break;
            }
        }
        if count_to_remove > 0 {
            to_remove.push((y + count - count_to_remove, count_to_remove));
        }
        y += count;
    }
    to_remove
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_stops_sit_every_eight_columns() {
        let buffer = Buffer::new(true, 20, 4);
        assert_eq!(buffer.next_stop(Some(0)), 8);
        assert_eq!(buffer.next_stop(Some(8)), 16);
        assert_eq!(buffer.next_stop(Some(16)), 19, "past the last stop is the last column");
        assert_eq!(buffer.prev_stop(Some(9)), 8);
        assert_eq!(buffer.prev_stop(Some(3)), 0);
    }

    #[test]
    fn scrolling_a_full_screen_moves_the_top_row_into_history() {
        let mut buffer = Buffer::new(true, 4, 2);
        buffer.fill_viewport_rows(Attr::default(), 4);
        buffer.scroll(Attr::default(), false, 4);
        assert_eq!(buffer.lines.len(), 3);
        assert_eq!(buffer.ybase, 1);
    }

    #[test]
    fn the_history_is_capped() {
        let mut buffer = Buffer::new(true, 4, 2);
        buffer.fill_viewport_rows(Attr::default(), 4);
        for _ in 0..(SCROLLBACK + 50) {
            buffer.scroll(Attr::default(), false, 4);
        }
        assert_eq!(buffer.lines.len(), SCROLLBACK + 2);
        assert_eq!(buffer.ybase, SCROLLBACK);
    }
}
