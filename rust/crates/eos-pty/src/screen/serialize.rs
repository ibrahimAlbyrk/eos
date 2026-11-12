//! The screen as text a client writes into a fresh terminal of the same size
//! to see it again: `@xterm/addon-serialize` 0.14.0 (`SerializeAddon.ts`),
//! decision for decision, so the text is the one clients get today.
//!
//! Like the addon it keeps colours and the on/off attributes, and drops
//! underline style, underline colour and link targets (a link's text comes
//! out underlined).

use std::fmt::Write as _;

use super::attrs::{Attr, CM_P16, CM_P256, CM_RGB};
use super::buffer::Buffer;
use super::line::HAS_CONTENT;
use super::term::{Mouse, Term};

fn equal_fg(a: &Attr, b: &Attr) -> bool {
    a.fg_mode() == b.fg_mode() && a.fg_color() == b.fg_color()
}

fn equal_bg(a: &Attr, b: &Attr) -> bool {
    a.bg_mode() == b.bg_mode() && a.bg_color() == b.bg_color()
}

fn equal_flags(a: &Attr, b: &Attr) -> bool {
    a.is_inverse() == b.is_inverse()
        && a.is_bold() == b.is_bold()
        && a.underline() == b.underline()
        && a.is_overline() == b.is_overline()
        && a.is_blink() == b.is_blink()
        && a.is_invisible() == b.is_invisible()
        && a.is_italic() == b.is_italic()
        && a.is_dim() == b.is_dim()
        && a.is_strikethrough() == b.is_strikethrough()
}

fn push_color(
    seq: &mut Vec<u32>,
    mode: u32,
    color: Option<u32>,
    extended: u32,
    bright: u32,
    normal: u32,
    default: u32,
) {
    let value = color.unwrap_or(0);
    match mode {
        CM_RGB => seq.extend([extended, 2, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]),
        CM_P16 | CM_P256 => {
            if value >= 16 {
                seq.extend([extended, 5, value]);
            } else {
                seq.push(if value & 8 != 0 { bright + (value & 7) } else { normal + (value & 7) });
            }
        }
        _ => seq.push(default),
    }
}

/// The SGR parameters that turn `old` into `cell`; empty when they look alike.
fn diff_style(cell: &Attr, old: &Attr) -> Vec<u32> {
    let mut seq = Vec::new();
    let fg_changed = !equal_fg(cell, old);
    let bg_changed = !equal_bg(cell, old);
    let flags_changed = !equal_flags(cell, old);
    if !(fg_changed || bg_changed || flags_changed) {
        return seq;
    }
    if cell.is_default() {
        if !old.is_default() {
            seq.push(0);
        }
        return seq;
    }
    if fg_changed {
        push_color(&mut seq, cell.fg_mode(), cell.fg_color(), 38, 90, 30, 39);
    }
    if bg_changed {
        push_color(&mut seq, cell.bg_mode(), cell.bg_color(), 48, 100, 40, 49);
    }
    if flags_changed {
        fn flag(seq: &mut Vec<u32>, now: bool, before: bool, on: u32, off: u32) {
            if now != before {
                seq.push(if now { on } else { off });
            }
        }
        flag(&mut seq, cell.is_inverse(), old.is_inverse(), 7, 27);
        flag(&mut seq, cell.is_bold(), old.is_bold(), 1, 22);
        if cell.underline() != old.underline() {
            seq.push(if cell.underline() != 0 { 4 } else { 24 });
        }
        flag(&mut seq, cell.is_overline(), old.is_overline(), 53, 55);
        flag(&mut seq, cell.is_blink(), old.is_blink(), 5, 25);
        flag(&mut seq, cell.is_invisible(), old.is_invisible(), 8, 28);
        flag(&mut seq, cell.is_italic(), old.is_italic(), 3, 23);
        flag(&mut seq, cell.is_dim(), old.is_dim(), 2, 22);
        flag(&mut seq, cell.is_strikethrough(), old.is_strikethrough(), 9, 29);
    }
    seq
}

fn push_sgr(out: &mut String, seq: &[u32]) {
    out.push_str("\x1b[");
    for (i, n) in seq.iter().enumerate() {
        if i > 0 {
            out.push(';');
        }
        let _ = write!(out, "{n}");
    }
    out.push('m');
}

struct Handler<'a> {
    buffer: &'a Buffer,
    term_rows: isize,
    rows: Vec<String>,
    separators: Vec<String>,
    current: String,
    null_cells: isize,
    /// The style the client's cursor carries at this point of the text, and
    /// the cell it was taken from.
    cursor_style: Attr,
    cursor_style_row: isize,
    cursor_style_col: isize,
    /// What an erase paints with on the client by now.
    background: Attr,
    first_row: isize,
    last_cursor_row: isize,
    last_cursor_col: isize,
    last_content_row: isize,
    last_content_col: isize,
}

impl<'a> Handler<'a> {
    fn new(buffer: &'a Buffer, term_rows: isize, start: isize) -> Self {
        Self {
            buffer,
            term_rows,
            rows: Vec::new(),
            separators: Vec::new(),
            current: String::new(),
            null_cells: 0,
            cursor_style: Attr::default(),
            cursor_style_row: 0,
            cursor_style_col: 0,
            background: Attr::default(),
            first_row: start,
            last_cursor_row: start,
            last_cursor_col: 0,
            last_content_row: start,
            last_content_col: 0,
        }
    }

    fn next_cell(&mut self, row: isize, col: isize) {
        let Some(line) = self.buffer.lines.get(row) else { return };
        let Some(cell) = line.cell(col) else { return };
        // The second half of a wide character.
        if cell.width() == 0 {
            return;
        }
        let empty = cell.content & HAS_CONTENT == 0;
        let sgr = diff_style(&cell.attr, &self.cursor_style);
        // An empty cell shows only its background.
        let style_changed = if empty { !equal_bg(&self.cursor_style, &cell.attr) } else { !sgr.is_empty() };

        if style_changed {
            if self.null_cells > 0 {
                if !equal_bg(&self.cursor_style, &self.background) {
                    let _ = write!(self.current, "\x1b[{}X", self.null_cells);
                }
                let _ = write!(self.current, "\x1b[{}C", self.null_cells);
                self.null_cells = 0;
            }
            self.last_content_row = row;
            self.last_cursor_row = row;
            self.last_content_col = col;
            self.last_cursor_col = col;
            push_sgr(&mut self.current, &sgr);
            self.cursor_style = cell.attr;
            self.cursor_style_row = row;
            self.cursor_style_col = col;
        }

        if empty {
            self.null_cells += cell.width() as isize;
            return;
        }
        if self.null_cells > 0 {
            if !equal_bg(&self.cursor_style, &self.background) {
                let _ = write!(self.current, "\x1b[{}X", self.null_cells);
            }
            let _ = write!(self.current, "\x1b[{}C", self.null_cells);
            self.null_cells = 0;
        }
        self.current.push_str(&line.text(col));
        self.last_content_row = row;
        self.last_cursor_row = row;
        self.last_content_col = col + cell.width() as isize;
        self.last_cursor_col = self.last_content_col;
    }

    fn row_end(&mut self, row: isize, is_last: bool) {
        // Coloured empty cells at the end of the row have to be painted.
        if self.null_cells > 0 && !equal_bg(&self.cursor_style, &self.background) {
            let _ = write!(self.current, "\x1b[{}X", self.null_cells);
        }

        let mut separator = String::new();
        if !is_last {
            // Once the client's screen scrolls, new rows take the cursor's background.
            if row - self.first_row >= self.term_rows
                && let Some(cell) =
                    self.buffer.lines.get(self.cursor_style_row).and_then(|l| l.cell(self.cursor_style_col))
            {
                self.background = cell.attr;
            }
            let (current, next) = (self.buffer.lines.get(row), self.buffer.lines.get(row + 1));
            if let (Some(current), Some(next)) = (current, next) {
                if !next.wrapped {
                    separator.push_str("\r\n");
                    self.last_cursor_row = row + 1;
                    self.last_cursor_col = 0;
                } else {
                    let len = current.len();
                    let last = current.cell(len - 1).copied().unwrap_or_default();
                    let second_last = current.cell(len - 2).copied().unwrap_or_default();
                    let first = next.cell(0).copied().unwrap_or_default();
                    let first_is_wide = first.width() > 1;
                    let has_text = |c: &super::line::Cell| c.content & HAS_CONTENT != 0;

                    // Can the wrap happen by itself when the client replays the text?
                    let mut natural = false;
                    let fits =
                        if has_text(&first) && first_is_wide { self.null_cells <= 1 } else { self.null_cells <= 0 };
                    if fits {
                        if (has_text(&last) || last.width() == 0) && equal_bg(&last.attr, &first.attr) {
                            natural = true;
                        }
                        if first_is_wide
                            && (has_text(&second_last) || second_last.width() == 0)
                            && equal_bg(&last.attr, &first.attr)
                            && equal_bg(&second_last.attr, &first.attr)
                        {
                            natural = true;
                        }
                    }

                    if !natural {
                        // Force it: print up to the margin, step back, erase what was printed.
                        for _ in 0..=self.null_cells {
                            separator.push('-');
                        }
                        separator.push_str("\x1b[1D\x1b[1X");
                        if self.null_cells > 0 {
                            let kept = len - self.null_cells;
                            let _ = write!(separator, "\x1b[A\x1b[{kept}C\x1b[{}X\x1b[{kept}D\x1b[B", self.null_cells);
                        }
                        self.last_content_row = row + 1;
                        self.last_content_col = 0;
                        self.last_cursor_row = row + 1;
                        self.last_cursor_col = 0;
                    }
                }
            }
        }

        self.rows.push(std::mem::take(&mut self.current));
        self.separators.push(separator);
        self.null_cells = 0;
    }

    fn finish(mut self, pen: &Attr) -> String {
        let mut row_end = self.rows.len() as isize;
        // Without scrollback the trailing empty rows are left out.
        if self.buffer.lines.len() - self.first_row <= self.term_rows {
            row_end = self.last_content_row + 1 - self.first_row;
            self.last_cursor_col = self.last_content_col;
            self.last_cursor_row = self.last_content_row;
        }

        let mut content = String::new();
        for i in 0..row_end.max(0) as usize {
            let Some(row) = self.rows.get(i) else { break };
            content.push_str(row);
            if (i as isize) + 1 < row_end {
                content.push_str(&self.separators[i]);
            }
        }

        let cursor_row = self.buffer.ybase + self.buffer.y;
        let cursor_col = self.buffer.x;
        if cursor_row != self.last_cursor_row || cursor_col != self.last_cursor_col {
            let down = cursor_row - self.last_cursor_row;
            if down > 0 {
                let _ = write!(content, "\x1b[{down}B");
            } else if down < 0 {
                let _ = write!(content, "\x1b[{}A", -down);
            }
            let right = cursor_col - self.last_cursor_col;
            if right > 0 {
                let _ = write!(content, "\x1b[{right}C");
            } else if right < 0 {
                let _ = write!(content, "\x1b[{}D", -right);
            }
        }

        let sgr = diff_style(pen, &self.cursor_style);
        if !sgr.is_empty() {
            push_sgr(&mut content, &sgr);
        }
        content
    }
}

fn serialize_buffer(term: &Term, buffer: &Buffer) -> String {
    let end = buffer.lines.len() - 1;
    let mut handler = Handler::new(buffer, term.rows, 0);
    for row in 0..=end {
        if let Some(line) = buffer.lines.get(row) {
            let cols = if row == end { term.cols } else { line.len() };
            for col in 0..cols {
                handler.next_cell(row, col);
            }
        }
        handler.row_end(row, row == end);
    }
    handler.finish(&term.cur)
}

pub(super) fn serialize(term: &Term) -> String {
    let mut out = serialize_buffer(term, &term.normal);
    if term.alt_active {
        out.push_str("\x1b[?1049h\x1b[H");
        out.push_str(&serialize_buffer(term, &term.alt));
    }

    let modes = &term.modes;
    for (on, text) in [
        (modes.application_cursor_keys, "\x1b[?1h"),
        (modes.application_keypad, "\x1b[?66h"),
        (modes.bracketed_paste, "\x1b[?2004h"),
        (modes.insert, "\x1b[4h"),
        (modes.origin, "\x1b[?6h"),
        (modes.reverse_wraparound, "\x1b[?45h"),
        (modes.send_focus, "\x1b[?1004h"),
        (!modes.wraparound, "\x1b[?7l"),
    ] {
        if on {
            out.push_str(text);
        }
    }
    out.push_str(match term.mouse {
        Mouse::None => "",
        Mouse::X10 => "\x1b[?9h",
        Mouse::Vt200 => "\x1b[?1000h",
        Mouse::Drag => "\x1b[?1002h",
        Mouse::Any => "\x1b[?1003h",
    });
    // The two the addon skips and today's mirror adds.
    if term.sgr_mouse {
        out.push_str("\x1b[?1006h");
    }
    if term.cursor_hidden {
        out.push_str("\x1b[?25l");
    }
    out
}
