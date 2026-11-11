//! Feeds a recorded byte stream to the Rust screen mirror and prints its
//! snapshot: `mirror-snapshot <script.bin> <cols> <rows> [<cols2> <rows2>]`
//! (with a second size, the mirror is resized after the bytes are in).

use std::io::Write;

use anyhow::Context;
use spike_pty::mirror::ScreenMirror;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let file = args.next().context("usage: mirror-snapshot <script.bin> <cols> <rows>")?;
    let cols: u16 = args.next().context("cols")?.parse()?;
    let rows: u16 = args.next().context("rows")?.parse()?;
    let mut mirror = ScreenMirror::new(cols, rows);
    // In uneven pieces, as a PTY delivers them: sequences get split.
    for piece in std::fs::read(file)?.chunks(37) {
        mirror.write(piece);
    }
    if let (Some(c), Some(r)) = (args.next(), args.next()) {
        mirror.resize(c.parse()?, r.parse()?);
    }
    std::io::stdout().write_all(mirror.snapshot().as_bytes())?;
    Ok(())
}
