//! The JavaScript regular expressions the TypeScript uses, run by an engine with
//! ECMAScript semantics (`\s`, `\p{L}`, `/i` folding), so the same text matches.

use std::sync::LazyLock;

use regress::Regex;

/// Compiles a pattern written in this crate. A pattern that does not compile is a
/// programming error; `every_pattern_compiles` forces each one.
pub(crate) fn compile(pattern: &str, flags: &str) -> Regex {
    match Regex::with_flags(pattern, flags) {
        Ok(re) => re,
        Err(e) => panic!("built-in pattern {pattern:?} does not compile: {e}"),
    }
}

macro_rules! pattern {
    ($(#[$meta:meta])* $name:ident, $pattern:expr, $flags:expr) => {
        $(#[$meta])*
        pub(crate) static $name: std::sync::LazyLock<regress::Regex> =
            std::sync::LazyLock::new(|| $crate::re::compile($pattern, $flags));
    };
}
pub(crate) use pattern;

pub(crate) fn is_match(re: &LazyLock<Regex>, text: &str) -> bool {
    re.find(text).is_some()
}

pattern!(LETTER, r"^\p{L}$", "u");
pattern!(NUMBER, r"^\p{N}$", "u");

/// `\p{L}`.
pub(crate) fn is_letter(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphabetic();
    }
    is_match(&LETTER, c.encode_utf8(&mut [0; 4]))
}

/// `\p{N}`.
pub(crate) fn is_number(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_digit();
    }
    is_match(&NUMBER, c.encode_utf8(&mut [0; 4]))
}

/// `[\p{L}_$]` on one UTF-16 code unit (half a surrogate pair is never a letter).
pub(crate) fn is_ident_start(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(|c| c == '_' || c == '$' || is_letter(c))
}

/// `[\p{L}\p{N}_$]` on one UTF-16 code unit.
pub(crate) fn is_ident_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(|c| c == '_' || c == '$' || is_letter(c) || is_number(c))
}

/// `[\p{L}\p{N}]` on one UTF-16 code unit.
pub(crate) fn is_word_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(|c| is_letter(c) || is_number(c))
}
