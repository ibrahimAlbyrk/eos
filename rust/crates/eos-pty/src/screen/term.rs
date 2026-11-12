//! What each character, control and sequence does to the screen
//! (`common/InputHandler.ts`), with the terminal state it acts on.
//!
//! Sequences that only make a terminal answer (device attributes, status
//! reports) or change how it draws (cursor shape, colours, titles) are not
//! here: nothing reads the mirror but the serializer.

use super::attrs::{
    Attr, BG_DIM, BG_ITALIC, BG_OVERLINE, BG_PROTECTED, CM_MASK, CM_P16, CM_P256, CM_RGB, Ext, FG_BLINK, FG_BOLD,
    FG_INVERSE, FG_INVISIBLE, FG_STRIKETHROUGH, FG_UNDERLINE, PCOLOR_MASK, RGB_MASK,
};
use super::buffer::{Buffer, blank_line};
use super::charsets::{self, Charsets};
use super::line::{Cell, CellData};
use super::parser::{Params, Perform};
use super::width::{char_props, props_join, props_width};

/// Which mouse events the program asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum Mouse {
    #[default]
    None,
    X10,
    Vt200,
    Drag,
    Any,
}

/// The modes a snapshot hands back to a client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Modes {
    pub(super) insert: bool,
    pub(super) application_cursor_keys: bool,
    pub(super) application_keypad: bool,
    pub(super) bracketed_paste: bool,
    pub(super) origin: bool,
    pub(super) reverse_wraparound: bool,
    pub(super) send_focus: bool,
    pub(super) wraparound: bool,
}

impl Default for Modes {
    fn default() -> Self {
        Self {
            insert: false,
            application_cursor_keys: false,
            application_keypad: false,
            bracketed_paste: false,
            origin: false,
            reverse_wraparound: false,
            send_focus: false,
            wraparound: true,
        }
    }
}

/// A count a sequence asks for is honoured up to this: past it nothing on a
/// terminal of any allowed size can still change (xterm loops the full count).
const MAX_REPEAT: isize = 1 << 20;

#[derive(Debug, Clone)]
pub(super) struct Term {
    pub(super) cols: isize,
    pub(super) rows: isize,
    pub(super) normal: Buffer,
    pub(super) alt: Buffer,
    pub(super) alt_active: bool,
    /// The pen: what the next character is drawn with.
    pub(super) cur: Attr,
    charsets: Charsets,
    pub(super) modes: Modes,
    pub(super) mouse: Mouse,
    /// A line feed also returns the carriage (`CSI 20 h`). An option in
    /// xterm, so a reset leaves it.
    convert_eol: bool,
    /// Tracked for the snapshot beside xterm's own state, exactly as today's
    /// mirror tracks them: SGR mouse encoding (1006) and cursor visibility (25).
    pub(super) sgr_mouse: bool,
    pub(super) cursor_hidden: bool,
}

impl Term {
    pub(super) fn new(cols: isize, rows: isize) -> Self {
        let (cols, rows) = (cols.max(2), rows.max(1));
        let mut term = Self {
            cols,
            rows,
            normal: Buffer::new(true, cols, rows),
            alt: Buffer::new(false, cols, rows),
            alt_active: false,
            cur: Attr::default(),
            charsets: Charsets::default(),
            modes: Modes::default(),
            mouse: Mouse::None,
            convert_eol: false,
            sgr_mouse: false,
            cursor_hidden: false,
        };
        term.normal.fill_viewport_rows(Attr::default(), cols);
        term
    }

    pub(super) fn resize(&mut self, cols: isize, rows: isize) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        let (cols, rows) = (cols.max(2), rows.max(1));
        self.cols = cols;
        self.rows = rows;
        self.normal.resize(cols, rows);
        self.alt.resize(cols, rows);
        self.normal.setup_tab_stops(Some(cols));
        self.alt.setup_tab_stops(Some(cols));
    }

    pub(super) fn active(&self) -> &Buffer {
        if self.alt_active { &self.alt } else { &self.normal }
    }

    fn buf(&mut self) -> &mut Buffer {
        if self.alt_active { &mut self.alt } else { &mut self.normal }
    }

    /// What an erase leaves behind: the pen's background, nothing else.
    fn erase_attr(&self) -> Attr {
        Attr { fg: 0, bg: self.cur.bg & 0x03FF_FFFF, ext: Ext::NONE }
    }

    fn null_cell(&self) -> CellData {
        CellData::empty(self.erase_attr())
    }

    fn full_reset(&mut self) {
        self.cur = Attr::default();
        self.normal = Buffer::new(true, self.cols, self.rows);
        self.normal.fill_viewport_rows(Attr::default(), self.cols);
        self.alt = Buffer::new(false, self.cols, self.rows);
        self.alt_active = false;
        self.charsets = Charsets::default();
        self.modes = Modes::default();
        self.mouse = Mouse::None;
        self.sgr_mouse = false;
        self.cursor_hidden = false;
    }

    // ---- cursor ----------------------------------------------------------

    fn restrict_cursor(&mut self, max_col: Option<isize>) {
        let (cols, rows, origin) = (self.cols, self.rows, self.modes.origin);
        let buf = self.buf();
        buf.x = buf.x.max(0).min(max_col.unwrap_or(cols - 1));
        buf.y = if origin { buf.y.max(buf.scroll_top).min(buf.scroll_bottom) } else { buf.y.max(0).min(rows - 1) };
    }

    fn set_cursor(&mut self, x: isize, y: isize) {
        let origin = self.modes.origin;
        let buf = self.buf();
        buf.x = x;
        buf.y = if origin { buf.scroll_top.saturating_add(y) } else { y };
        self.restrict_cursor(None);
    }

    fn move_cursor(&mut self, dx: isize, dy: isize) {
        self.restrict_cursor(None);
        let (x, y) = (self.buf().x, self.buf().y);
        self.set_cursor(x.saturating_add(dx), y.saturating_add(dy));
    }

    fn cursor_up(&mut self, n: isize) {
        let to_top = self.buf().y - self.buf().scroll_top;
        self.move_cursor(0, if to_top >= 0 { -to_top.min(n) } else { -n });
    }

    fn cursor_down(&mut self, n: isize) {
        let to_bottom = self.buf().scroll_bottom - self.buf().y;
        self.move_cursor(0, if to_bottom >= 0 { to_bottom.min(n) } else { n });
    }

    fn save_cursor(&mut self) {
        let (cur, charset) = (self.cur, self.charsets.active);
        let buf = self.buf();
        buf.saved_x = buf.x;
        buf.saved_y = buf.ybase + buf.y;
        buf.saved_fg = cur.fg;
        buf.saved_bg = cur.bg;
        buf.saved_charset = charset;
    }

    fn restore_cursor(&mut self) {
        let buf = self.buf();
        buf.x = buf.saved_x;
        buf.y = (buf.saved_y - buf.ybase).max(0);
        let (fg, bg, charset) = (buf.saved_fg, buf.saved_bg, buf.saved_charset);
        self.cur.fg = fg;
        self.cur.bg = bg;
        // A saved plain-ASCII set restores as "none", bypassing the slots.
        self.charsets.active = charset;
        self.restrict_cursor(None);
    }

    // ---- C0 --------------------------------------------------------------

    fn line_feed(&mut self) {
        let (cols, rows, erase) = (self.cols, self.rows, self.erase_attr());
        let convert_eol = self.convert_eol;
        let buf = self.buf();
        if convert_eol {
            buf.x = 0;
        }
        buf.y += 1;
        if buf.y == buf.scroll_bottom + 1 {
            buf.y -= 1;
            buf.scroll(erase, false, cols);
        } else if buf.y >= rows {
            buf.y = rows - 1;
        } else if let Some(line) = buf.line_mut(buf.y) {
            line.wrapped = false;
        }
        if buf.x >= cols {
            buf.x -= 1;
        }
    }

    fn backspace(&mut self) {
        if !self.modes.reverse_wraparound {
            self.restrict_cursor(None);
            let buf = self.buf();
            if buf.x > 0 {
                buf.x -= 1;
            }
            return;
        }
        let cols = self.cols;
        self.restrict_cursor(Some(cols));
        let buf = self.buf();
        if buf.x > 0 {
            buf.x -= 1;
        } else if buf.x == 0
            && buf.y > buf.scroll_top
            && buf.y <= buf.scroll_bottom
            && buf.line(buf.y).is_some_and(|l| l.wrapped)
        {
            if let Some(line) = buf.line_mut(buf.y) {
                line.wrapped = false;
            }
            buf.y -= 1;
            buf.x = cols - 1;
            // Onto the first half of a wide character that ends the row above.
            if buf.line(buf.y).is_some_and(|l| l.has_width(buf.x) && !l.has_content(buf.x)) {
                buf.x -= 1;
            }
        }
        self.restrict_cursor(None);
    }

    fn tab(&mut self) {
        let cols = self.cols;
        let buf = self.buf();
        if buf.x < cols {
            buf.x = buf.next_stop(None);
        }
    }

    fn index(&mut self) {
        self.restrict_cursor(None);
        let (cols, rows, erase) = (self.cols, self.rows, self.erase_attr());
        let buf = self.buf();
        buf.y += 1;
        if buf.y == buf.scroll_bottom + 1 {
            buf.y -= 1;
            buf.scroll(erase, false, cols);
        } else if buf.y >= rows {
            buf.y = rows - 1;
        }
        self.restrict_cursor(None);
    }

    fn reverse_index(&mut self) {
        self.restrict_cursor(None);
        let (cols, erase) = (self.cols, self.erase_attr());
        let buf = self.buf();
        if buf.y == buf.scroll_top {
            let (top, bottom) = (buf.ybase + buf.scroll_top, buf.ybase + buf.scroll_bottom);
            if buf.lines.remove(bottom).is_some() {
                buf.lines.insert(top, blank_line(cols, erase, false));
            }
        } else {
            buf.y -= 1;
            self.restrict_cursor(None);
        }
    }

    // ---- printing --------------------------------------------------------

    fn print_run(&mut self, data: &[u32], join: &mut u32) {
        let (cols, rows) = (self.cols, self.rows);
        let (wraparound, insert) = (self.modes.wraparound, self.modes.insert);
        let cur = self.cur;
        let erase = self.erase_attr();
        let charset = self.charsets.active;
        let buf = if self.alt_active { &mut self.alt } else { &mut self.normal };
        let mut row = buf.ybase + buf.y;
        if buf.lines.get(row).is_none() {
            return;
        }

        // Printing over the second half of a wide character leaves its first half empty.
        if buf.x != 0
            && !data.is_empty()
            && let Some(line) = buf.lines.get_mut(row)
            && line.width(buf.x - 1) == 2
        {
            line.set_from_codepoint(buf.x - 1, 0, 1, &cur);
        }

        let mut preceding = *join;
        for &raw in data {
            let mut code = raw;
            if code < 127
                && let Some(charset) = charset
            {
                code = charsets::translate(charset, code);
            }
            let props = char_props(code, preceding);
            let mut width = props_width(props) as isize;
            let joins = props_join(props);
            let old_width = if joins { props_width(preceding) as isize } else { 0 };
            preceding = props;

            if buf.x + width - old_width > cols {
                if wraparound {
                    let mut old_row = row;
                    let mut old_col = buf.x - old_width;
                    buf.x = old_width;
                    buf.y += 1;
                    if buf.y == buf.scroll_bottom + 1 {
                        buf.y -= 1;
                        let shifts = buf.scroll_top != 0 || buf.lines.is_full();
                        buf.scroll(erase, true, cols);
                        if shifts {
                            old_row -= 1;
                        }
                    } else {
                        if buf.y >= rows {
                            buf.y = rows - 1;
                        }
                        if let Some(line) = buf.line_mut(buf.y) {
                            line.wrapped = true;
                        }
                    }
                    row = buf.ybase + buf.y;
                    // A one-row screen without history reuses the row it scrolls away.
                    if old_row < 0 {
                        old_row = row;
                    }
                    if old_width > 0 {
                        // The character a mark is joining moves down with it.
                        copy_between(buf, row, old_row, old_col, 0, old_width);
                    }
                    if let Some(line) = buf.lines.get_mut(old_row) {
                        while old_col < cols {
                            line.set_from_codepoint(old_col, 0, 1, &cur);
                            old_col += 1;
                        }
                    }
                } else {
                    buf.x = cols - 1;
                    if width == 2 {
                        continue;
                    }
                }
            }

            let Some(line) = buf.lines.get_mut(row) else { return };

            if joins && buf.x != 0 {
                let offset = if line.width(buf.x - 1) != 0 { 1 } else { 2 };
                line.add_codepoint(buf.x - offset, code, width as u32);
                for _ in 0..(width - old_width).max(0) {
                    line.set_from_codepoint(buf.x, 0, 0, &cur);
                    buf.x += 1;
                }
                continue;
            }

            if insert {
                line.insert_cells(buf.x, width - old_width, &CellData::empty(cur));
                if line.width(cols - 1) == 2 {
                    line.set_from_codepoint(cols - 1, 0, 1, &cur);
                }
            }

            line.set_from_codepoint(buf.x, code, width as u32, &cur);
            buf.x += 1;
            while width > 1 {
                line.set_from_codepoint(buf.x, 0, 0, &cur);
                buf.x += 1;
                width -= 1;
            }
        }
        *join = preceding;

        // The cell under the cursor is whole again if it was a wide character's second half.
        if buf.x < cols
            && !data.is_empty()
            && let Some(line) = buf.lines.get_mut(row)
            && line.width(buf.x) == 0
            && !line.has_content(buf.x)
        {
            line.set_from_codepoint(buf.x, 0, 1, &cur);
        }
    }

    fn repeat_preceding(&mut self, count: isize, join: u32) {
        if join == 0 {
            return;
        }
        let buf = self.active();
        let x = buf.x - props_width(join) as isize;
        let text: Vec<u32> = buf.line(buf.y).map(|l| l.text(x)).unwrap_or_default().chars().map(u32::from).collect();
        if text.is_empty() {
            return;
        }
        let data: Vec<u32> =
            text.iter().copied().cycle().take(text.len() * count.clamp(1, MAX_REPEAT) as usize).collect();
        let mut join = join;
        self.print_run(&data, &mut join);
    }

    // ---- erasing and shifting --------------------------------------------

    fn erase_in_line(&mut self, y: isize, start: isize, end: isize, clear_wrap: bool, respect_protect: bool) {
        let null = self.null_cell();
        if let Some(line) = self.buf().line_mut(y) {
            line.replace_cells(start, end, &null, respect_protect);
            if clear_wrap {
                line.wrapped = false;
            }
        }
    }

    fn reset_line(&mut self, y: isize, respect_protect: bool) {
        let null = self.null_cell();
        if let Some(line) = self.buf().line_mut(y) {
            line.fill(&null, respect_protect);
            line.wrapped = false;
        }
    }

    fn erase_in_display(&mut self, mode: i32, respect_protect: bool) {
        let (cols, rows) = (self.cols, self.rows);
        self.restrict_cursor(Some(cols));
        let (x, y) = (self.buf().x, self.buf().y);
        match mode {
            0 => {
                self.erase_in_line(y, x, cols, x == 0, respect_protect);
                for j in y + 1..rows {
                    self.reset_line(j, respect_protect);
                }
            }
            1 => {
                self.erase_in_line(y, 0, x + 1, true, respect_protect);
                if x + 1 >= cols {
                    // xterm addresses this row without the scrollback offset.
                    if let Some(line) = self.buf().lines.get_mut(y + 1) {
                        line.wrapped = false;
                    }
                }
                for j in (0..y).rev() {
                    self.reset_line(j, respect_protect);
                }
            }
            2 => {
                for j in (0..rows).rev() {
                    self.reset_line(j, respect_protect);
                }
            }
            3 => {
                let buf = self.buf();
                let scrollback = buf.lines.len() - rows;
                if scrollback > 0 {
                    buf.lines.trim_start(scrollback);
                    buf.ybase = (buf.ybase - scrollback).max(0);
                }
            }
            _ => {}
        }
    }

    fn erase_in_row(&mut self, mode: i32, respect_protect: bool) {
        let cols = self.cols;
        self.restrict_cursor(Some(cols));
        let (x, y) = (self.buf().x, self.buf().y);
        match mode {
            0 => self.erase_in_line(y, x, cols, x == 0, respect_protect),
            1 => self.erase_in_line(y, 0, x + 1, false, respect_protect),
            2 => self.erase_in_line(y, 0, cols, true, respect_protect),
            _ => {}
        }
    }

    /// Rows of the scroll region move: each step drops the row at `remove`
    /// and puts an empty one at `insert` (absolute offsets from the top of
    /// the screen).
    fn shift_rows(&mut self, count: isize, remove: isize, insert: isize, fill: Attr) {
        let (cols, rows) = (self.cols, self.rows);
        let buf = self.buf();
        for _ in 0..count.min(rows) {
            if buf.lines.remove(buf.ybase + remove).is_some() {
                buf.lines.insert(buf.ybase + insert, blank_line(cols, fill, false));
            }
        }
    }

    fn in_scroll_region(&self) -> bool {
        let buf = self.active();
        buf.y <= buf.scroll_bottom && buf.y >= buf.scroll_top
    }

    fn insert_lines(&mut self, n: isize) {
        self.restrict_cursor(None);
        if !self.in_scroll_region() {
            return;
        }
        let (y, bottom, erase) = (self.buf().y, self.buf().scroll_bottom, self.erase_attr());
        self.shift_rows(n, bottom, y, erase);
        self.buf().x = 0;
    }

    fn delete_lines(&mut self, n: isize) {
        self.restrict_cursor(None);
        if !self.in_scroll_region() {
            return;
        }
        let (y, bottom, erase) = (self.buf().y, self.buf().scroll_bottom, self.erase_attr());
        self.shift_rows(n, y, bottom, erase);
        self.buf().x = 0;
    }

    /// The same change to every row of the scroll region (column shifts).
    fn for_region_rows(&mut self, change: impl Fn(&mut super::line::Line, isize, &CellData)) {
        if !self.in_scroll_region() {
            return;
        }
        let null = self.null_cell();
        let buf = self.buf();
        let x = buf.x;
        for y in buf.scroll_top..=buf.scroll_bottom {
            if let Some(line) = buf.line_mut(y) {
                change(line, x, &null);
                line.wrapped = false;
            }
        }
    }

    fn on_cursor_row(&mut self, change: impl FnOnce(&mut super::line::Line, isize, &CellData)) {
        self.restrict_cursor(None);
        let null = self.null_cell();
        let buf = self.buf();
        let x = buf.x;
        if let Some(line) = buf.line_mut(buf.y) {
            change(line, x, &null);
        }
    }

    fn alignment_pattern(&mut self) {
        let cell = CellData {
            cell: Cell {
                content: (1 << 22) | u32::from(b'E'),
                attr: Attr { fg: self.cur.fg, bg: self.cur.bg, ext: Ext::NONE },
            },
            combined: String::new(),
        };
        self.set_cursor(0, 0);
        let rows = self.rows;
        let buf = self.buf();
        for offset in 0..rows {
            // With a top margin in origin mode the count runs past the last
            // row. xterm's row list is a ring: once it is full, such an index
            // comes back around to the oldest rows, and they are filled too.
            let mut index = buf.ybase + buf.y + offset;
            if index >= buf.lines.len() && buf.lines.is_full() {
                index -= buf.lines.len();
            }
            if let Some(line) = buf.lines.get_mut(index) {
                line.fill(&cell, false);
                line.wrapped = false;
            }
        }
        self.set_cursor(0, 0);
    }

    // ---- modes -----------------------------------------------------------

    fn soft_reset(&mut self) {
        let rows = self.rows;
        self.cur = Attr::default();
        self.modes = Modes::default();
        self.charsets = Charsets::default();
        let buf = self.buf();
        buf.scroll_top = 0;
        buf.scroll_bottom = rows - 1;
        buf.saved_x = 0;
        buf.saved_y = buf.ybase;
        buf.saved_fg = 0;
        buf.saved_bg = 0;
        buf.saved_charset = None;
    }

    fn set_ansi_mode(&mut self, params: &Params, on: bool) {
        for p in params.main() {
            match p {
                4 => self.modes.insert = on,
                20 => self.convert_eol = on,
                _ => {}
            }
        }
    }

    fn enter_alt_screen(&mut self) {
        if self.alt_active {
            return;
        }
        let (erase, cols) = (self.erase_attr(), self.cols);
        self.alt.fill_viewport_rows(erase, cols);
        self.alt.x = self.normal.x;
        self.alt.y = self.normal.y;
        self.alt_active = true;
    }

    fn leave_alt_screen(&mut self) {
        if !self.alt_active {
            return;
        }
        self.normal.x = self.alt.x;
        self.normal.y = self.alt.y;
        self.alt.clear();
        self.alt_active = false;
    }

    fn set_private_mode(&mut self, params: &Params) {
        for p in params.main() {
            match p {
                1 => self.modes.application_cursor_keys = true,
                2 => (0..4).for_each(|slot| self.charsets.set_slot(slot, None)),
                6 => {
                    self.modes.origin = true;
                    self.set_cursor(0, 0);
                }
                7 => self.modes.wraparound = true,
                45 => self.modes.reverse_wraparound = true,
                66 => self.modes.application_keypad = true,
                9 => self.mouse = Mouse::X10,
                1000 => self.mouse = Mouse::Vt200,
                1002 => self.mouse = Mouse::Drag,
                1003 => self.mouse = Mouse::Any,
                1004 => self.modes.send_focus = true,
                1048 => self.save_cursor(),
                1049 => {
                    self.save_cursor();
                    self.enter_alt_screen();
                }
                47 | 1047 => self.enter_alt_screen(),
                2004 => self.modes.bracketed_paste = true,
                _ => {}
            }
        }
    }

    fn reset_private_mode(&mut self, params: &Params) {
        for p in params.main() {
            match p {
                1 => self.modes.application_cursor_keys = false,
                6 => {
                    self.modes.origin = false;
                    self.set_cursor(0, 0);
                }
                7 => self.modes.wraparound = false,
                45 => self.modes.reverse_wraparound = false,
                66 => self.modes.application_keypad = false,
                9 | 1000 | 1002 | 1003 => self.mouse = Mouse::None,
                1004 => self.modes.send_focus = false,
                1048 => self.restore_cursor(),
                1049 => {
                    self.leave_alt_screen();
                    self.restore_cursor();
                }
                47 | 1047 => self.leave_alt_screen(),
                2004 => self.modes.bracketed_paste = false,
                _ => {}
            }
        }
    }

    fn set_scroll_region(&mut self, params: &Params) {
        let rows = self.rows;
        let top = nonzero(params.get(0));
        let mut bottom = params.get(1) as isize;
        if params.len() < 2 || bottom > rows || bottom == 0 {
            bottom = rows;
        }
        if bottom > top {
            let buf = self.buf();
            buf.scroll_top = top - 1;
            buf.scroll_bottom = bottom - 1;
            self.set_cursor(0, 0);
        }
    }

    // ---- attributes ------------------------------------------------------

    fn char_attributes(&mut self, params: &Params) {
        if params.len() == 1 && params.get(0) == 0 {
            sgr_reset(&mut self.cur);
            return;
        }
        let attr = &mut self.cur;
        let mut i = 0;
        while i < params.len() {
            let p = params.get(i);
            match p {
                30..=37 => attr.fg = (attr.fg & !(CM_MASK | PCOLOR_MASK)) | CM_P16 | (p - 30) as u32,
                40..=47 => attr.bg = (attr.bg & !(CM_MASK | PCOLOR_MASK)) | CM_P16 | (p - 40) as u32,
                90..=97 => attr.fg = (attr.fg & !(CM_MASK | PCOLOR_MASK)) | CM_P16 | (p - 90) as u32 | 8,
                100..=107 => attr.bg = (attr.bg & !(CM_MASK | PCOLOR_MASK)) | CM_P16 | (p - 100) as u32 | 8,
                0 => sgr_reset(attr),
                1 => attr.fg |= FG_BOLD,
                3 => attr.bg |= BG_ITALIC,
                4 => {
                    attr.fg |= FG_UNDERLINE;
                    underline(params.subs(i).first().copied().unwrap_or(1), attr);
                }
                5 => attr.fg |= FG_BLINK,
                7 => attr.fg |= FG_INVERSE,
                8 => attr.fg |= FG_INVISIBLE,
                9 => attr.fg |= FG_STRIKETHROUGH,
                2 => attr.bg |= BG_DIM,
                21 => underline(2, attr),
                22 => {
                    attr.fg &= !FG_BOLD;
                    attr.bg &= !BG_DIM;
                }
                23 => attr.bg &= !BG_ITALIC,
                24 => {
                    attr.fg &= !FG_UNDERLINE;
                    underline(0, attr);
                }
                25 => attr.fg &= !FG_BLINK,
                27 => attr.fg &= !FG_INVERSE,
                28 => attr.fg &= !FG_INVISIBLE,
                29 => attr.fg &= !FG_STRIKETHROUGH,
                39 => attr.fg &= !(CM_MASK | RGB_MASK),
                49 => attr.bg &= !(CM_MASK | RGB_MASK),
                38 | 48 | 58 => i += extract_color(params, i, attr),
                53 => attr.bg |= BG_OVERLINE,
                55 => attr.bg &= !BG_OVERLINE,
                59 => {
                    attr.ext.set_underline_color(u32::MAX);
                    attr.update_extended();
                }
                _ => {}
            }
            i += 1;
        }
    }

    fn set_hyperlink(&mut self, data: &str) {
        let Some((id, uri)) = data.split_once(';') else { return };
        if !uri.is_empty() {
            self.cur.ext.set_link(true);
        } else if id.trim().is_empty() {
            self.cur.ext.set_link(false);
        } else {
            return;
        }
        self.cur.update_extended();
    }
}

/// A parameter, with a missing or zero one read as 1.
fn nonzero(p: i32) -> isize {
    if p == 0 { 1 } else { p as isize }
}

fn sgr_reset(attr: &mut Attr) {
    attr.fg = 0;
    attr.bg = 0;
    attr.ext.set_underline_style(0);
    attr.ext.set_underline_color(0);
    // Inside a link the extended word is still in use.
    attr.update_extended();
}

fn underline(style: i32, attr: &mut Attr) {
    let style = if !(0..=5).contains(&style) { 1 } else { style as u32 };
    attr.ext.set_underline_style(style);
    attr.fg |= FG_UNDERLINE;
    if style == 0 {
        attr.fg &= !FG_UNDERLINE;
    }
    attr.update_extended();
}

fn updated_color(mut color: u32, mode: i32, c1: i32, c2: i32, c3: i32) -> u32 {
    if mode == 2 {
        color |= CM_RGB;
        color &= !RGB_MASK;
        color |= ((c1 & 255) as u32) << 16 | ((c2 & 255) as u32) << 8 | (c3 & 255) as u32;
    } else if mode == 5 {
        color &= !(CM_MASK | PCOLOR_MASK);
        color |= CM_P256 | (c1 & 0xff) as u32;
    }
    color
}

/// Reads an extended colour (`38`, `48`, `58`) in either spelling —
/// `38;2;r;g;b` or `38:2::r:g:b` — and returns how many further parameters
/// it used.
fn extract_color(params: &Params, pos: usize, attr: &mut Attr) -> usize {
    // xterm's six slots; a malformed sequence may write a little past them.
    const SLOTS: usize = 6;
    let mut accu = [0i32; 16];
    accu[2] = -1;
    let mut c_space = 0;
    let mut advance = 0;
    loop {
        accu[advance + c_space] = params.get(pos + advance);
        let subs = params.subs(pos + advance);
        if !subs.is_empty() {
            let mut i = 0;
            loop {
                if accu[1] == 5 {
                    c_space = 1;
                }
                accu[advance + i + 1 + c_space] = subs[i];
                i += 1;
                if !(i < subs.len() && i + advance + 1 + c_space < SLOTS) {
                    break;
                }
            }
            break;
        }
        if (accu[1] == 5 && advance + c_space >= 2) || (accu[1] == 2 && advance + c_space >= 5) {
            break;
        }
        if accu[1] != 0 {
            c_space = 1;
        }
        advance += 1;
        if !(advance + pos < params.len() && advance + c_space < SLOTS) {
            break;
        }
    }
    for slot in &mut accu[2..SLOTS] {
        if *slot == -1 {
            *slot = 0;
        }
    }
    match accu[0] {
        38 => attr.fg = updated_color(attr.fg, accu[1], accu[3], accu[4], accu[5]),
        48 => attr.bg = updated_color(attr.bg, accu[1], accu[3], accu[4], accu[5]),
        58 => {
            let color = updated_color(attr.ext.underline_color(), accu[1], accu[3], accu[4], accu[5]);
            attr.ext.set_underline_color(color);
        }
        _ => {}
    }
    advance
}

/// Copies `count` cells from row `src` to the start of row `dest`; the rows
/// may be one and the same.
fn copy_between(buf: &mut Buffer, dest: isize, src: isize, src_col: isize, dest_col: isize, count: isize) {
    if dest == src {
        if let Some(line) = buf.lines.get_mut(dest) {
            line.copy_cells_within(src_col, dest_col, count, false);
        }
        return;
    }
    let Some(mut target) = buf.lines.get_mut(dest).map(std::mem::take) else { return };
    if let Some(source) = buf.lines.get(src) {
        target.copy_cells_from(source, src_col, dest_col, count, false);
    }
    if let Some(slot) = buf.lines.get_mut(dest) {
        *slot = target;
    }
}

const fn csi(prefix: u8, intermediate: u8, last: u8) -> u32 {
    let mut ident = prefix as u32;
    if intermediate != 0 {
        ident = (ident << 8) | intermediate as u32;
    }
    (ident << 8) | last as u32
}

impl Perform for Term {
    fn print(&mut self, text: &[u32], join: &mut u32) {
        self.print_run(text, join);
    }

    fn execute(&mut self, code: u32) {
        match code {
            0x0a..=0x0c => self.line_feed(),
            0x0d => self.buf().x = 0,
            0x08 => self.backspace(),
            0x09 => self.tab(),
            0x0e => self.charsets.set_level(1),
            0x0f => self.charsets.set_level(0),
            0x84 => self.index(),
            0x85 => {
                self.buf().x = 0;
                self.index();
            }
            0x88 => {
                let x = self.buf().x;
                self.buf().tabs.insert(x);
            }
            _ => {}
        }
    }

    fn csi(&mut self, ident: u32, params: &Params, join: u32) {
        const PRIVATE: u8 = b'?';
        let p0 = params.get(0);
        let n = nonzero(p0);
        let cols = self.cols;

        // Today's mirror watches these two modes itself, before xterm acts.
        if ident == csi(PRIVATE, 0, b'h') || ident == csi(PRIVATE, 0, b'l') {
            let on = ident == csi(PRIVATE, 0, b'h');
            if params.main().contains(&1006) {
                self.sgr_mouse = on;
            }
            if params.main().contains(&25) {
                self.cursor_hidden = !on;
            }
        }

        match ident {
            i if i == csi(0, 0, b'@') => self.on_cursor_row(|line, x, null| line.insert_cells(x, n, null)),
            i if i == csi(0, b' ', b'@') => self.for_region_rows(|line, _, null| line.delete_cells(0, n, null)),
            i if i == csi(0, 0, b'A') => self.cursor_up(n),
            i if i == csi(0, b' ', b'A') => self.for_region_rows(|line, _, null| line.insert_cells(0, n, null)),
            i if i == csi(0, 0, b'B') => self.cursor_down(n),
            i if i == csi(0, 0, b'C') || i == csi(0, 0, b'a') => self.move_cursor(n, 0),
            i if i == csi(0, 0, b'D') => self.move_cursor(-n, 0),
            i if i == csi(0, 0, b'E') => {
                self.cursor_down(n);
                self.buf().x = 0;
            }
            i if i == csi(0, 0, b'F') => {
                self.cursor_up(n);
                self.buf().x = 0;
            }
            i if i == csi(0, 0, b'G') || i == csi(0, 0, b'`') => {
                let y = self.buf().y;
                self.set_cursor(n - 1, y);
            }
            i if i == csi(0, 0, b'H') || i == csi(0, 0, b'f') => {
                let x = if params.len() >= 2 { nonzero(params.get(1)) - 1 } else { 0 };
                self.set_cursor(x, n - 1);
            }
            i if i == csi(0, 0, b'I') => {
                let buf = self.buf();
                if buf.x < cols {
                    for _ in 0..n.min(cols) {
                        buf.x = buf.next_stop(None);
                    }
                }
            }
            i if i == csi(0, 0, b'J') => self.erase_in_display(p0, false),
            i if i == csi(PRIVATE, 0, b'J') => self.erase_in_display(p0, true),
            i if i == csi(0, 0, b'K') => self.erase_in_row(p0, false),
            i if i == csi(PRIVATE, 0, b'K') => self.erase_in_row(p0, true),
            i if i == csi(0, 0, b'L') => self.insert_lines(n),
            i if i == csi(0, 0, b'M') => self.delete_lines(n),
            i if i == csi(0, 0, b'P') => self.on_cursor_row(|line, x, null| line.delete_cells(x, n, null)),
            i if i == csi(0, 0, b'S') => {
                let (top, bottom, erase) = (self.buf().scroll_top, self.buf().scroll_bottom, self.erase_attr());
                self.shift_rows(n, top, bottom, erase);
            }
            i if i == csi(0, 0, b'T') => {
                let (top, bottom) = (self.buf().scroll_top, self.buf().scroll_bottom);
                self.shift_rows(n, bottom, top, Attr::default());
            }
            i if i == csi(0, 0, b'X') => {
                self.on_cursor_row(|line, x, null| line.replace_cells(x, x.saturating_add(n), null, false));
            }
            i if i == csi(0, 0, b'Z') => {
                let buf = self.buf();
                if buf.x < cols {
                    for _ in 0..n.min(cols) {
                        buf.x = buf.prev_stop(None);
                    }
                }
            }
            i if i == csi(0, 0, b'b') => self.repeat_preceding(n, join),
            i if i == csi(0, 0, b'd') => {
                let x = self.buf().x;
                self.set_cursor(x, n - 1);
            }
            i if i == csi(0, 0, b'e') => self.move_cursor(0, n),
            i if i == csi(0, 0, b'g') => {
                let buf = self.buf();
                match p0 {
                    0 => {
                        buf.tabs.remove(&buf.x);
                    }
                    3 => buf.tabs.clear(),
                    _ => {}
                }
            }
            i if i == csi(0, 0, b'h') => self.set_ansi_mode(params, true),
            i if i == csi(0, 0, b'l') => self.set_ansi_mode(params, false),
            i if i == csi(PRIVATE, 0, b'h') => self.set_private_mode(params),
            i if i == csi(PRIVATE, 0, b'l') => self.reset_private_mode(params),
            i if i == csi(0, 0, b'm') => self.char_attributes(params),
            i if i == csi(0, b'!', b'p') => self.soft_reset(),
            i if i == csi(0, 0, b'r') => self.set_scroll_region(params),
            i if i == csi(0, 0, b's') => self.save_cursor(),
            i if i == csi(0, 0, b'u') => self.restore_cursor(),
            i if i == csi(0, b'\'', b'}') => self.for_region_rows(|line, x, null| line.insert_cells(x, n, null)),
            i if i == csi(0, b'\'', b'~') => self.for_region_rows(|line, x, null| line.delete_cells(x, n, null)),
            i if i == csi(0, b'"', b'q') => match p0 {
                1 => self.cur.bg |= BG_PROTECTED,
                0 | 2 => self.cur.bg &= !BG_PROTECTED,
                _ => {}
            },
            _ => {}
        }
    }

    fn esc(&mut self, ident: u32) -> bool {
        const fn two(intermediate: u8, last: u8) -> u32 {
            ((intermediate as u32) << 8) | last as u32
        }
        match ident {
            0x37 => self.save_cursor(),
            0x38 => self.restore_cursor(),
            0x44 => self.index(),
            0x45 => {
                self.buf().x = 0;
                self.index();
            }
            0x48 => {
                let x = self.buf().x;
                self.buf().tabs.insert(x);
            }
            0x4d => self.reverse_index(),
            0x3d => self.modes.application_keypad = true,
            0x3e => self.modes.application_keypad = false,
            0x63 => {
                self.full_reset();
                return true;
            }
            0x6e | 0x7d => self.charsets.set_level(2),
            0x6f | 0x7c => self.charsets.set_level(3),
            0x7e => self.charsets.set_level(1),
            i if i == two(b'%', b'@') || i == two(b'%', b'G') => {
                self.charsets.set_level(0);
                self.charsets.set_slot(0, None);
            }
            i if i == two(b'#', b'8') => self.alignment_pattern(),
            i if i >> 16 == 0 => {
                let slot = match (i >> 8) as u8 {
                    b'(' => 0,
                    b')' | b'-' => 1,
                    b'*' | b'.' => 2,
                    b'+' => 3,
                    _ => return false,
                };
                if let Some(charset) = charsets::by_flag(i as u8) {
                    self.charsets.set_slot(slot, charset);
                }
            }
            _ => {}
        }
        false
    }

    fn osc(&mut self, id: i32, data: &str) {
        if id == 8 {
            self.set_hyperlink(data);
        }
    }

    fn wants_osc(&self, id: i32) -> bool {
        id == 8
    }
}

#[cfg(test)]
mod tests {
    use super::super::parser::Parser;
    use super::*;

    fn feed(term: &mut Term, text: &str) {
        let data: Vec<u32> = text.chars().map(u32::from).collect();
        Parser::new().parse(&data, term);
    }

    fn row(term: &Term, y: isize) -> String {
        let line = term.active().line(y).expect("row");
        (0..line.len()).map(|x| line.text(x)).collect()
    }

    #[test]
    fn text_wraps_and_marks_the_continuation() {
        let mut term = Term::new(5, 3);
        feed(&mut term, "abcdefg");
        assert_eq!(row(&term, 0), "abcde");
        assert_eq!(row(&term, 1), "fg");
        assert!(term.active().line(1).expect("row").wrapped);
        assert_eq!((term.active().x, term.active().y), (2, 1));
    }

    #[test]
    fn the_cursor_waits_past_the_last_column() {
        let mut term = Term::new(5, 3);
        feed(&mut term, "abcde");
        assert_eq!((term.active().x, term.active().y), (5, 0));
        feed(&mut term, "\r\n");
        assert!(!term.active().line(1).expect("row").wrapped);
    }

    #[test]
    fn a_wide_character_that_does_not_fit_moves_to_the_next_row() {
        let mut term = Term::new(5, 3);
        feed(&mut term, "abcd漢");
        assert_eq!(row(&term, 0), "abcd");
        assert_eq!(row(&term, 1), "漢");
    }

    #[test]
    fn the_alternate_screen_keeps_the_normal_one() {
        let mut term = Term::new(10, 3);
        feed(&mut term, "shell\x1b[?1049h\x1b[Happ");
        assert!(term.alt_active);
        assert_eq!(row(&term, 0), "app");
        feed(&mut term, "\x1b[?1049l");
        assert!(!term.alt_active);
        assert_eq!(row(&term, 0), "shell");
        assert_eq!(term.active().x, 5, "the cursor is back where the shell left it");
    }

    #[test]
    fn line_drawing_maps_ascii() {
        let mut term = Term::new(10, 2);
        feed(&mut term, "\x1b(0lqk\x1b(Blqk");
        assert_eq!(row(&term, 0), "┌─┐lqk");
    }

    #[test]
    fn a_scroll_region_scrolls_alone() {
        let mut term = Term::new(4, 4);
        feed(&mut term, "a\r\nb\r\nc\r\nd\x1b[2;3r\x1b[3;1H\n");
        assert_eq!([row(&term, 0), row(&term, 1), row(&term, 2), row(&term, 3)], ["a", "c", "", "d"]);
        assert_eq!(term.active().ybase, 0, "nothing went to the history");
    }

    #[test]
    fn a_reset_keeps_the_size_and_clears_the_rest() {
        let mut term = Term::new(6, 2);
        feed(&mut term, "\x1b[31mred\x1b[?1049h\x1b[?1006h\x1bc");
        assert!(!term.alt_active && !term.sgr_mouse);
        assert!(term.cur.is_default());
        assert_eq!(row(&term, 0), "");
    }
}
