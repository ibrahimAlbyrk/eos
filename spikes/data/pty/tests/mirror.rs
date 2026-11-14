//! Self-consistency of the Rust screen mirror on the scripted sessions
//! (fixtures/pty, frozen). Equivalence with xterm.js's snapshot is held by
//! `eos-pty`'s mirror vectors.

use std::{fs, path::PathBuf};

use spike_pty::mirror::ScreenMirror;

fn scripts() -> Vec<(String, Vec<u8>)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/pty");
    let mut out: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "bin"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), fs::read(&p).unwrap()))
        .collect();
    out.sort();
    assert!(out.len() >= 6);
    out
}

#[test]
fn taking_a_snapshot_leaves_the_mirror_as_it_was() {
    for (name, bytes) in scripts() {
        let mut mirror = ScreenMirror::new(80, 24);
        mirror.write(&bytes);
        let first = mirror.snapshot();
        assert_eq!(mirror.snapshot(), first, "{name}: a second snapshot differs");
        // And the session goes on as if nothing happened.
        mirror.write(b"more");
        let mut untouched = ScreenMirror::new(80, 24);
        untouched.write(&bytes);
        untouched.write(b"more");
        assert_eq!(mirror.snapshot(), untouched.snapshot(), "{name}: the snapshot disturbed the mirror");
    }
}

#[test]
fn a_terminal_rebuilt_from_a_snapshot_gives_the_same_snapshot() {
    for (name, bytes) in scripts() {
        let mut mirror = ScreenMirror::new(80, 24);
        mirror.write(&bytes);
        let snapshot = mirror.snapshot();
        let mut rebuilt = ScreenMirror::new(80, 24);
        rebuilt.write(snapshot.as_bytes());
        assert_eq!(rebuilt.snapshot(), snapshot, "{name}");
    }
}

#[test]
fn bytes_split_anywhere_give_the_same_screen() {
    for (name, bytes) in scripts() {
        let mut whole = ScreenMirror::new(80, 24);
        whole.write(&bytes);
        let want = whole.snapshot();
        for size in [1usize, 2, 3, 5, 7, 4096] {
            let mut pieces = ScreenMirror::new(80, 24);
            for piece in bytes.chunks(size) {
                pieces.write(piece);
            }
            assert_eq!(pieces.snapshot(), want, "{name} in pieces of {size}");
        }
    }
}

/// The case vt100 itself gets wrong: a two-byte character cut in half loses
/// the byte that follows it.
#[test]
fn a_character_cut_in_half_by_a_read_loses_nothing() {
    let text = "aç Ğb 漢 x😀 y".as_bytes();
    let mut whole = ScreenMirror::new(80, 24);
    whole.write(text);
    let want = whole.snapshot();
    assert!(want.contains("aç Ğb 漢 x😀 y"));
    for at in 1..text.len() {
        let mut cut = ScreenMirror::new(80, 24);
        cut.write(&text[..at]);
        cut.write(&text[at..]);
        assert_eq!(cut.snapshot(), want, "cut at byte {at}");
    }
}

#[test]
fn an_alternate_screen_snapshot_carries_the_primary_screen_under_it() {
    let mut mirror = ScreenMirror::new(80, 24);
    mirror.write(b"$ before\r\n\x1b[?1049h\x1b[2J\x1b[Hfull screen\x1b[?1004h\x1b[?25l");
    let snapshot = mirror.snapshot();
    let (primary, alternate) = snapshot.split_once("\x1b[?1049h").expect("enters the alternate screen");
    assert!(primary.contains("$ before"));
    assert!(alternate.contains("full screen"));
    assert!(alternate.contains("\x1b[?25l"), "hidden cursor");
    assert!(alternate.ends_with("\x1b[?1004h"), "focus reporting is restored");

    let mut client = ScreenMirror::new(80, 24);
    client.write(snapshot.as_bytes());
    client.write(b"\x1b[?1049l");
    assert!(client.snapshot().contains("$ before"), "leaving the app shows the shell again");
}
