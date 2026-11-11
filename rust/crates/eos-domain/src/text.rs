//! Strings as JavaScript sees them. Stored text and prompt text were shaped by
//! JavaScript's `trim`, `\s`, `length` and `slice`; rules that must give the
//! same bytes use these instead of the standard library's near-equivalents.

/// What `\s` matches and `String.prototype.trim` strips. Not `char::is_whitespace`:
/// U+FEFF counts, U+0085 does not.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.trimEnd()`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

/// `s.trimStart()`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// `s.replace(/\s+/g, " ")`.
pub fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `s.length`: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, units)`. A cut that falls inside a surrogate pair drops the
/// whole character: a Rust string cannot hold the half JavaScript would keep.
pub fn utf16_prefix(s: &str, units: usize) -> &str {
    let mut seen = 0;
    for (at, c) in s.char_indices() {
        seen += c.len_utf16();
        if seen > units {
            return &s[..at];
        }
    }
    s
}

/// Rough size of `text` in model tokens: 3.5 UTF-16 units per token, rounded
/// up (`estimateTokens`). For budgets and estimates only.
pub fn estimate_tokens(text: &str) -> i64 {
    // Exact in integers: ceil(len / 3.5) = ceil(2·len / 7).
    let len = utf16_len(text) as i64;
    (2 * len + 6) / 7
}

/// A JavaScript regex literal, compiled once.
macro_rules! js_re {
    ($pattern:literal) => {
        $crate::text::js_re!($pattern, "")
    };
    ($pattern:literal, $flags:literal) => {{
        static RE: std::sync::LazyLock<regress::Regex> = std::sync::LazyLock::new(|| {
            // The patterns are literals in this crate; a test compiles each one.
            regress::Regex::with_flags($pattern, $flags).unwrap_or_else(|e| panic!("regex {}: {e}", $pattern))
        });
        &*RE
    }};
}
pub(crate) use js_re;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_what_javascript_trims() {
        assert_eq!(js_trim("\u{feff}\u{a0} a b \u{2028}\n"), "a b");
        assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}", "U+0085 is not JavaScript whitespace");
        assert_eq!(js_trim_end(" a \t"), " a");
        assert_eq!(js_trim_start(" a \t"), "a \t");
        assert_eq!(collapse_spaces(" a \n\t b\u{3000}c "), " a b c ");
    }

    #[test]
    fn counts_and_cuts_in_utf16_units() {
        assert_eq!(utf16_len("aé😀"), 4);
        assert_eq!(utf16_prefix("aé😀b", 2), "aé");
        assert_eq!(utf16_prefix("aé😀b", 3), "aé", "half a pair is dropped");
        assert_eq!(utf16_prefix("aé😀b", 4), "aé😀");
        assert_eq!(utf16_prefix("ab", 9), "ab");
    }

    #[test]
    fn estimates_tokens_as_the_typescript_does() {
        // Math.ceil(n / 3.5) for n = 0, 1, 7, 8, 385
        for (n, want) in [(0, 0), (1, 1), (3, 1), (4, 2), (7, 2), (8, 3), (385, 110)] {
            assert_eq!(estimate_tokens(&"x".repeat(n)), want, "{n}");
        }
        assert_eq!(estimate_tokens("😀😀"), 2);
    }
}
