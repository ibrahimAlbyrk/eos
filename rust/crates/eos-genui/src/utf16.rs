//! The parsers read their input as UTF-16 code units, like the JavaScript ones:
//! offsets, columns, length limits and the single "character" quoted in an error
//! all count units, and agents read those numbers.
//!
//! Text leaves through [`text`]: a lone surrogate (half of a pair the source cut
//! in two, or a `\uD83D` escape with no partner) becomes U+FFFD, which is also
//! what Node writes when such a string is encoded as UTF-8.

use crate::js::is_ws_unit;

pub(crate) fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

pub(crate) fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

pub(crate) const fn unit(c: char) -> u16 {
    c as u16
}

/// `s.indexOf(c, from)` for one unit.
pub(crate) fn find_unit(s: &[u16], c: u16, from: usize) -> Option<usize> {
    s.get(from..)?.iter().position(|u| *u == c).map(|at| at + from)
}

/// `s.indexOf(needle, from)` for an ASCII needle.
pub(crate) fn find(s: &[u16], needle: &str, from: usize) -> Option<usize> {
    let needle = needle.as_bytes();
    let first = u16::from(*needle.first()?);
    let mut at = from;
    while let Some(hit) = find_unit(s, first, at) {
        if starts_with_bytes(s, hit, needle) {
            return Some(hit);
        }
        at = hit + 1;
    }
    None
}

/// `s.startsWith(prefix, at)` for an ASCII prefix.
pub(crate) fn starts_with(s: &[u16], at: usize, prefix: &str) -> bool {
    starts_with_bytes(s, at, prefix.as_bytes())
}

fn starts_with_bytes(s: &[u16], at: usize, prefix: &[u8]) -> bool {
    s.get(at..at + prefix.len()).is_some_and(|w| w.iter().zip(prefix).all(|(u, b)| *u == u16::from(*b)))
}

pub(crate) fn is(s: &[u16], at: usize, c: char) -> bool {
    s.get(at) == Some(&unit(c))
}

/// The unit as an ASCII byte, or 0 for anything else (0 never matches a class).
pub(crate) fn ascii(u: u16) -> u8 {
    if u < 0x80 { u as u8 } else { 0 }
}

pub(crate) fn trim(s: &[u16]) -> &[u16] {
    trim_end(trim_start(s))
}

pub(crate) fn trim_start(s: &[u16]) -> &[u16] {
    let n = s.iter().take_while(|u| is_ws_unit(**u)).count();
    &s[n..]
}

pub(crate) fn trim_end(s: &[u16]) -> &[u16] {
    let n = s.iter().rev().take_while(|u| is_ws_unit(**u)).count();
    &s[..s.len() - n]
}

pub(crate) fn is_blank(s: &[u16]) -> bool {
    s.iter().all(|u| is_ws_unit(*u))
}
