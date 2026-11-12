//! The screen mirror: a terminal that is fed what the clients are sent and
//! can say, at any moment, what a client must write into a fresh terminal of
//! the same size to see the same screen (`GET /pty/:id/buffer`).
//!
//! It is xterm.js 6.0.0's buffer model and input handler with the serialize
//! addon 0.14.0 — what `manager/services/pty/screenMirror.ts` runs — ported
//! behaviour for behaviour: a snapshot is equal, byte for byte, to today's.
//! `tests/mirror_vectors.rs` holds it to that over sessions the TypeScript
//! mirror was run on.

mod attrs;
mod buffer;
mod charsets;
mod line;
mod lines;
mod parser;
mod serialize;
mod term;
mod width;

use parser::Parser;
use term::Term;

/// A headless terminal of `cols` × `rows` with 1000 lines of history.
#[derive(Debug, Clone)]
pub struct Screen {
    term: Term,
    parser: Parser,
    /// Reused between writes: the text as code points.
    decoded: Vec<u32>,
}

impl Screen {
    /// At least 2 columns and 1 row, as xterm has it.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { term: Term::new(cols as isize, rows as isize), parser: Parser::new(), decoded: Vec::new() }
    }

    /// Feeds terminal output. Sequences may be cut anywhere between calls.
    pub fn write(&mut self, data: &str) {
        self.decoded.clear();
        // xterm's decoder drops byte-order marks.
        self.decoded.extend(data.chars().filter(|c| *c != '\u{FEFF}').map(u32::from));
        self.parser.parse(&self.decoded, &mut self.term);
        if self.decoded.capacity() > 1 << 16 {
            self.decoded = Vec::new();
        }
    }

    /// Changes the size; the history re-wraps as xterm's does.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(cols as isize, rows as isize);
    }

    /// The text that redraws this screen: history, screen, cursor, modes.
    pub fn snapshot(&self) -> String {
        serialize::serialize(&self.term)
    }
}
