//! The screen mirror on `vt100`: fed the same bytes the clients get, it can
//! say what a client must write into a fresh terminal of the same size to see
//! the screen as it is (`GET /pty/:id/buffer`).
//!
//! `vt100` formats the visible grid of the active screen. A reattaching client
//! needs more, so `snapshot` adds:
//! - the scrollback, printed first so it scrolls into the client's own;
//! - the primary screen under an alternate screen (the app will leave it);
//! - modes `vt100` does not keep: focus reporting (1004).

use std::num::NonZeroU16;

use vt100::capture::{BasicFormattedCaptureRange, BasicFormattedCaptureState};

/// xterm.js's default scrollback — what the clients keep.
pub const SCROLLBACK: usize = 1000;

/// Modes the terminal model has no slot for but a client must get back.
#[derive(Debug, Default)]
struct Extra {
    focus_reporting: bool,
}

impl vt100::Callbacks for Extra {
    fn unhandled_csi(&mut self, _: &mut vt100::Screen, i1: Option<u8>, _i2: Option<u8>, params: &[&[u16]], c: char) {
        if i1 != Some(b'?') || !(c == 'h' || c == 'l') {
            return;
        }
        for p in params {
            if p.first() == Some(&1004) {
                self.focus_reporting = c == 'h';
            }
        }
    }

    fn unhandled_escape(&mut self, _: &mut vt100::Screen, _i1: Option<u8>, _i2: Option<u8>, b: u8) {
        // RIS (ESC c) resets everything.
        if b == b'c' {
            self.focus_reporting = false;
        }
    }
}

/// How many bytes at the end of `bytes` start a UTF-8 character without
/// finishing it (0–3).
fn incomplete_utf8_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let b = bytes[bytes.len() - back];
        if b & 0xC0 == 0x80 {
            continue; // a continuation byte: keep looking for its lead
        }
        let needs = match b {
            0xF0..=0xF7 => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if needs > back { back } else { 0 };
    }
    0
}

/// A terminal is at least one cell wide and high.
fn dim(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n).unwrap_or(NonZeroU16::MIN)
}

pub struct ScreenMirror {
    parser: vt100::Parser<Extra>,
    /// The start of a UTF-8 character whose rest has not arrived yet.
    held: Vec<u8>,
}

impl std::fmt::Debug for ScreenMirror {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (rows, cols) = self.parser.screen().size();
        f.debug_struct("ScreenMirror").field("rows", &rows).field("cols", &cols).finish()
    }
}

impl ScreenMirror {
    pub fn new(cols: u16, rows: u16) -> Self {
        let parser = vt100::Parser::new_with_callbacks(dim(rows), dim(cols), SCROLLBACK, Extra::default());
        Self { parser, held: Vec::new() }
    }

    /// A PTY read ends wherever the kernel buffer did, often inside a
    /// character. vt100 0.18.1 (vte 0.15) drops the byte after a two-byte
    /// character that was split across two calls ("ç" + " " loses the space),
    /// so a character is only ever handed over whole.
    pub fn write(&mut self, data: &[u8]) {
        let keep = incomplete_utf8_tail(data);
        let (now, later) = data.split_at(data.len() - keep);
        if self.held.is_empty() {
            self.parser.process(now);
        } else {
            self.held.extend_from_slice(now);
            let whole = std::mem::take(&mut self.held);
            // `now` may itself be too short to finish the character.
            let keep = if later.is_empty() { incomplete_utf8_tail(&whole) } else { 0 };
            let (ready, rest) = whole.split_at(whole.len() - keep);
            self.parser.process(ready);
            self.held.extend_from_slice(rest);
        }
        self.held.extend_from_slice(later);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.screen_mut().set_size(dim(rows), dim(cols));
    }

    /// Bytes that rebuild this screen in a fresh terminal of the same size.
    pub fn snapshot(&mut self) -> String {
        let alternate = self.parser.screen().alternate_screen();
        // The primary grid is reachable only while it is the active one. Mode 47
        // switches grids without clearing either or touching a cursor, so the
        // round trip leaves the mirror as it was.
        if alternate {
            self.parser.process(b"\x1b[?47l");
        }
        let mut out = String::new();
        self.write_primary(&mut out);
        if alternate {
            self.parser.process(b"\x1b[?47h");
            out.push_str("\x1b[?1049h");
            // Clears, draws the visible rows, places the cursor, hides it if hidden.
            out.push_str(&self.parser.screen().contents_formatted());
        }
        let screen = self.parser.screen();
        out.push_str(&screen.input_mode_formatted());
        if self.parser.callbacks().focus_reporting {
            out.push_str("\x1b[?1004h");
        }
        out
    }

    /// Scrollback and screen rows of the primary grid, then its cursor.
    fn write_primary(&self, out: &mut String) {
        let screen = self.parser.screen();
        let mut basic = String::new();
        let mut state = BasicFormattedCaptureState::new();
        // SGR sequences and '\n' only: every row from the top of the scrollback.
        let _ = screen.write_contents_formatted_basic(&mut basic, BasicFormattedCaptureRange::Full(&mut state));
        out.push_str("\x1b[m");
        out.push_str(&basic.replace('\n', "\r\n"));
        out.push_str("\x1b[m");
        // The last screenful now fills the viewport, so the cursor's place on
        // screen is its place in the viewport.
        let (row, col) = screen.cursor_position();
        out.push_str(&format!("\x1b[{};{}H", row + 1, col + 1));
        out.push_str(&screen.attributes_formatted());
        if screen.hide_cursor() {
            out.push_str("\x1b[?25l");
        }
    }
}
