//! One row of cells (`common/buffer/BufferLine.ts`).
//!
//! Every operation is xterm's, step for step, because what a snapshot says
//! depends on details that look incidental: which cells are empty rather
//! than spaces, what an erase leaves under a wide character's second half,
//! where a combined character's text is kept.

use std::collections::BTreeMap;

use super::attrs::{Attr, BG_HAS_EXTENDED, BG_PROTECTED, Ext};

pub(super) const CODEPOINT_MASK: u32 = 0x1F_FFFF;
/// The cell's text is more than one code point; it is kept beside the cells.
pub(super) const IS_COMBINED: u32 = 0x20_0000;
pub(super) const HAS_CONTENT: u32 = 0x3F_FFFF;
const WIDTH_MASK: u32 = 0xC0_0000;
const WIDTH_SHIFT: u32 = 22;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) struct Cell {
    /// Code point (or [`IS_COMBINED`]) and, above it, the width in cells.
    pub(super) content: u32,
    pub(super) attr: Attr,
}

impl Cell {
    /// An empty cell: one wide, no character.
    pub(super) const EMPTY: Cell = Cell { content: 1 << WIDTH_SHIFT, attr: Attr { fg: 0, bg: 0, ext: Ext::NONE } };

    pub(super) fn width(&self) -> u32 {
        self.content >> WIDTH_SHIFT
    }
}

/// A cell taken out of a line, with its text when that is combined.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct CellData {
    pub(super) cell: Cell,
    pub(super) combined: String,
}

impl CellData {
    pub(super) fn empty(attr: Attr) -> Self {
        Self { cell: Cell { content: Cell::EMPTY.content, attr }, combined: String::new() }
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct Line {
    cells: Vec<Cell>,
    /// The text of combined cells, by column. Like xterm's, an entry can
    /// outlive its cell; it is read only where the cell says it is combined.
    combined: BTreeMap<usize, String>,
    /// This row continues the one above it.
    pub(super) wrapped: bool,
}

/// Columns arrive as signed numbers: xterm reads and writes typed arrays out
/// of range freely (a read gives nothing, a write is dropped), and so do these.
fn at(index: isize) -> Option<usize> {
    usize::try_from(index).ok()
}

impl Line {
    pub(super) fn new(cols: usize, fill: &CellData, wrapped: bool) -> Self {
        let mut line = Self { cells: vec![Cell::default(); cols], combined: BTreeMap::new(), wrapped };
        for i in 0..cols {
            line.set_cell(i as isize, fill);
        }
        line
    }

    pub(super) fn len(&self) -> isize {
        self.cells.len() as isize
    }

    fn content(&self, index: isize) -> u32 {
        at(index).and_then(|i| self.cells.get(i)).map_or(0, |c| c.content)
    }

    pub(super) fn width(&self, index: isize) -> u32 {
        self.content(index) >> WIDTH_SHIFT
    }

    pub(super) fn has_width(&self, index: isize) -> bool {
        self.content(index) & WIDTH_MASK != 0
    }

    pub(super) fn has_content(&self, index: isize) -> bool {
        self.content(index) & HAS_CONTENT != 0
    }

    pub(super) fn bg(&self, index: isize) -> u32 {
        at(index).and_then(|i| self.cells.get(i)).map_or(0, |c| c.attr.bg)
    }

    fn is_protected(&self, index: isize) -> bool {
        self.bg(index) & BG_PROTECTED != 0
    }

    /// The cell at `index`, for the serializer: `None` out of range.
    pub(super) fn cell(&self, index: isize) -> Option<&Cell> {
        at(index).and_then(|i| self.cells.get(i))
    }

    /// The text of a combined cell.
    pub(super) fn combined(&self, index: isize) -> &str {
        at(index).and_then(|i| self.combined.get(&i)).map_or("", String::as_str)
    }

    /// The cell's text.
    pub(super) fn text(&self, index: isize) -> String {
        let content = self.content(index);
        if content & IS_COMBINED != 0 {
            return self.combined(index).to_owned();
        }
        char::from_u32(content & CODEPOINT_MASK).filter(|c| *c != '\0').map(String::from).unwrap_or_default()
    }

    pub(super) fn load(&self, index: isize) -> CellData {
        let Some(cell) = self.cell(index) else { return CellData::default() };
        let combined = if cell.content & IS_COMBINED != 0 { self.combined(index).to_owned() } else { String::new() };
        CellData { cell: *cell, combined }
    }

    pub(super) fn set_cell(&mut self, index: isize, data: &CellData) {
        let Some(i) = at(index) else { return };
        if data.cell.content & IS_COMBINED != 0 {
            self.combined.insert(i, data.combined.clone());
        }
        if let Some(cell) = self.cells.get_mut(i) {
            *cell = data.cell;
        }
    }

    pub(super) fn set_from_codepoint(&mut self, index: isize, code: u32, width: u32, attr: &Attr) {
        if let Some(cell) = at(index).and_then(|i| self.cells.get_mut(i)) {
            let ext = if attr.bg & BG_HAS_EXTENDED != 0 { attr.ext } else { Ext::NONE };
            *cell = Cell { content: code | (width << WIDTH_SHIFT), attr: Attr { fg: attr.fg, bg: attr.bg, ext } };
        }
    }

    /// Appends a code point to the cell's character (a combining mark); a
    /// non-zero `width` becomes the cell's width.
    pub(super) fn add_codepoint(&mut self, index: isize, code: u32, width: u32) {
        let Some(i) = at(index).filter(|i| *i < self.cells.len()) else { return };
        let mut content = self.cells[i].content;
        let added = char::from_u32(code).unwrap_or('\u{FFFD}');
        if content & IS_COMBINED != 0 {
            self.combined.entry(i).or_default().push(added);
        } else if content & CODEPOINT_MASK != 0 {
            let mut text = String::new();
            text.extend(char::from_u32(content & CODEPOINT_MASK));
            text.push(added);
            self.combined.insert(i, text);
            content &= !CODEPOINT_MASK;
            content |= IS_COMBINED;
        } else {
            content = code | (1 << WIDTH_SHIFT);
        }
        if width != 0 {
            content &= !WIDTH_MASK;
            content |= width << WIDTH_SHIFT;
        }
        self.cells[i].content = content;
    }

    pub(super) fn insert_cells(&mut self, pos: isize, n: isize, fill: &CellData) {
        let len = self.len();
        if len == 0 {
            return;
        }
        let pos = pos.rem_euclid(len);
        if pos != 0 && self.width(pos - 1) == 2 {
            self.set_from_codepoint(pos - 1, 0, 1, &fill.cell.attr);
        }
        if n < len - pos {
            for i in (0..len - pos - n).rev() {
                let moved = self.load(pos + i);
                self.set_cell(pos + n + i, &moved);
            }
            for i in 0..n {
                self.set_cell(pos + i, fill);
            }
        } else {
            for i in pos..len {
                self.set_cell(i, fill);
            }
        }
        if self.width(len - 1) == 2 {
            self.set_from_codepoint(len - 1, 0, 1, &fill.cell.attr);
        }
    }

    pub(super) fn delete_cells(&mut self, pos: isize, n: isize, fill: &CellData) {
        let len = self.len();
        if len == 0 {
            return;
        }
        let pos = pos.rem_euclid(len);
        if n < len - pos {
            for i in 0..len - pos - n {
                let moved = self.load(pos + n + i);
                self.set_cell(pos + i, &moved);
            }
            for i in len - n..len {
                self.set_cell(i, fill);
            }
        } else {
            for i in pos..len {
                self.set_cell(i, fill);
            }
        }
        if pos != 0 && self.width(pos - 1) == 2 {
            self.set_from_codepoint(pos - 1, 0, 1, &fill.cell.attr);
        }
        if self.width(pos) == 0 && !self.has_content(pos) {
            self.set_from_codepoint(pos, 0, 1, &fill.cell.attr);
        }
    }

    pub(super) fn replace_cells(&mut self, mut start: isize, end: isize, fill: &CellData, respect_protect: bool) {
        let len = self.len();
        if respect_protect {
            if start != 0 && self.width(start - 1) == 2 && !self.is_protected(start - 1) {
                self.set_from_codepoint(start - 1, 0, 1, &fill.cell.attr);
            }
            if end < len && self.width(end - 1) == 2 && !self.is_protected(end) {
                self.set_from_codepoint(end, 0, 1, &fill.cell.attr);
            }
            while start < end && start < len {
                if !self.is_protected(start) {
                    self.set_cell(start, fill);
                }
                start += 1;
            }
            return;
        }
        if start != 0 && self.width(start - 1) == 2 {
            self.set_from_codepoint(start - 1, 0, 1, &fill.cell.attr);
        }
        if end < len && self.width(end - 1) == 2 {
            self.set_from_codepoint(end, 0, 1, &fill.cell.attr);
        }
        while start < end && start < len {
            self.set_cell(start, fill);
            start += 1;
        }
    }

    pub(super) fn resize(&mut self, cols: usize, fill: &CellData) {
        let len = self.cells.len();
        if cols > len {
            self.cells.resize(cols, Cell::default());
            for i in len..cols {
                self.set_cell(i as isize, fill);
            }
        } else if cols < len {
            self.cells.truncate(cols);
            self.combined.retain(|col, _| *col < cols);
        }
    }

    pub(super) fn fill(&mut self, fill: &CellData, respect_protect: bool) {
        if respect_protect {
            for i in 0..self.len() {
                if !self.is_protected(i) {
                    self.set_cell(i, fill);
                }
            }
            return;
        }
        self.combined.clear();
        for i in 0..self.len() {
            self.set_cell(i, fill);
        }
    }

    /// One past the last cell that holds a character.
    pub(super) fn trimmed_len(&self) -> isize {
        for (i, cell) in self.cells.iter().enumerate().rev() {
            if cell.content & HAS_CONTENT != 0 {
                return i as isize + cell.width() as isize;
            }
        }
        0
    }

    /// Copies `count` cells from `src`. The combined text of every column
    /// from `src_col` on comes along, also past the copied range: xterm does
    /// that, and a wrapped line's text after a resize shows it.
    pub(super) fn copy_cells_from(&mut self, src: &Line, src_col: isize, dest_col: isize, count: isize, reverse: bool) {
        let mut one = |offset: isize| {
            let from = at(src_col + offset).and_then(|i| src.cells.get(i)).copied();
            if let Some(to) = at(dest_col + offset).and_then(|i| self.cells.get_mut(i)) {
                // A read past the source's end gives a cell of zeros.
                *to = from.unwrap_or_default();
            }
        };
        if reverse {
            (0..count).rev().for_each(&mut one);
        } else {
            (0..count).for_each(&mut one);
        }
        for (col, text) in &src.combined {
            let col = *col as isize;
            if col >= src_col
                && let Some(to) = at(col - src_col + dest_col)
            {
                self.combined.insert(to, text.clone());
            }
        }
    }

    /// [`copy_cells_from`](Self::copy_cells_from) with the line as its own
    /// source: cells are read as they stand while the copy runs.
    pub(super) fn copy_cells_within(&mut self, src_col: isize, dest_col: isize, count: isize, reverse: bool) {
        let mut one = |offset: isize| {
            let from = at(src_col + offset).and_then(|i| self.cells.get(i)).copied();
            if let Some(to) = at(dest_col + offset).and_then(|i| self.cells.get_mut(i)) {
                *to = from.unwrap_or_default();
            }
        };
        if reverse {
            (0..count).rev().for_each(&mut one);
        } else {
            (0..count).for_each(&mut one);
        }
        let cols: Vec<usize> = self.combined.keys().copied().collect();
        for col in cols {
            if col as isize >= src_col
                && let Some(to) = at(col as isize - src_col + dest_col)
                && let Some(text) = self.combined.get(&col).cloned()
            {
                self.combined.insert(to, text);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, cols: usize) -> Line {
        let mut line = Line::new(cols, &CellData::empty(Attr::default()), false);
        for (i, c) in text.chars().enumerate() {
            line.set_from_codepoint(i as isize, u32::from(c), 1, &Attr::default());
        }
        line
    }

    fn text(line: &Line) -> String {
        (0..line.len()).map(|i| line.text(i)).map(|t| if t.is_empty() { "_".to_owned() } else { t }).collect()
    }

    #[test]
    fn inserting_and_deleting_cells_shift_the_rest_of_the_row() {
        let blank = CellData::empty(Attr::default());
        let mut l = line("abcdef", 8);
        l.insert_cells(2, 2, &blank);
        assert_eq!(text(&l), "ab__cdef");
        l.delete_cells(1, 3, &blank);
        assert_eq!(text(&l), "acdef___");
        l.replace_cells(1, 3, &blank, false);
        assert_eq!(text(&l), "a__ef___");
        assert_eq!(l.trimmed_len(), 5);
    }

    #[test]
    fn erasing_half_of_a_wide_character_clears_the_other_half() {
        let blank = CellData::empty(Attr::default());
        let mut l = line("ab", 6);
        l.set_from_codepoint(2, u32::from('漢'), 2, &Attr::default());
        l.set_from_codepoint(3, 0, 0, &Attr::default());
        l.replace_cells(3, 4, &blank, false);
        assert_eq!(l.width(2), 1, "the first half became an empty cell");
        assert!(!l.has_content(2));
    }

    #[test]
    fn a_mark_is_kept_with_its_character() {
        let mut l = line("e", 4);
        l.add_codepoint(0, 0x0301, 0);
        assert_eq!(l.text(0), "e\u{301}");
        l.add_codepoint(0, 0x0308, 0);
        assert_eq!(l.text(0), "e\u{301}\u{308}");
        assert_eq!(l.width(0), 1);
    }

    #[test]
    fn out_of_range_columns_read_as_nothing_and_ignore_writes() {
        let mut l = line("ab", 2);
        assert_eq!(l.width(-1), 0);
        assert_eq!(l.width(9), 0);
        l.set_from_codepoint(9, 65, 1, &Attr::default());
        l.set_from_codepoint(-1, 65, 1, &Attr::default());
        assert_eq!(text(&l), "ab");
    }
}
