//! Strings as JavaScript sees them. Stored text and prompt text were shaped by
//! JavaScript's `trim`, `\s`, `length` and `slice`; rules that must give the
//! same bytes use these instead of the standard library's near-equivalents.

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};

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

/// JavaScript's `a.localeCompare(b)` with no locale given: the Unicode
/// collation order, so `notes.txt` sorts before `README.md` and `é` next to
/// `e`. Every list today's code sorts with `localeCompare` (folder listings,
/// changed files, branches, symbols) goes through this.
///
/// The root collation is used whatever the system language is; today's code
/// follows the language Node was started with.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    let collator = COLLATOR.get_or_init(|| Collator::try_new(Default::default(), CollatorOptions::default()).ok());
    match collator {
        Some(collator) => collator.compare(a, b),
        // The compiled-in collation data always loads; byte order is the fallback if it ever does not.
        None => a.cmp(b),
    }
}

/// JavaScript's `a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })`:
/// `file2` before `file10`, and case and accents do not count (`a`, `A` and
/// `á` are equal). How a folder listing a person reads is sorted.
pub fn natural_compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    let collator = COLLATOR.get_or_init(|| {
        let mut preferences = icu_collator::CollatorPreferences::default();
        preferences.numeric_ordering = Some(icu_collator::preferences::CollationNumericOrdering::True);
        let mut options = CollatorOptions::default();
        options.strength = Some(icu_collator::options::Strength::Primary);
        Collator::try_new(preferences, options).ok()
    });
    match collator {
        Some(collator) => collator.compare(a, b),
        None => a.cmp(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_sorts_as_a_person_reads_it() {
        let mut names = vec!["file10.txt", "README.md", "file2.txt", "notes.txt", "Émile", "eric"];
        names.sort_by(|a, b| natural_compare(a, b));
        assert_eq!(names, ["Émile", "eric", "file2.txt", "file10.txt", "notes.txt", "README.md"]);
        assert_eq!(natural_compare("a.txt", "A.TXT"), Ordering::Equal);
        assert_eq!(natural_compare("resume", "résumé"), Ordering::Equal);
    }

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

    fn sorted(mut names: Vec<&str>) -> Vec<&str> {
        names.sort_by(|a, b| locale_compare(a, b));
        names
    }

    // Each expectation is what `[...].sort((a, b) => a.localeCompare(b))` prints in Node 26 (en-US).
    #[test]
    fn orders_as_javascript_locale_compare_does() {
        assert_eq!(sorted(vec!["README.md", "notes.txt", "Zed", "apple"]), ["apple", "notes.txt", "README.md", "Zed"]);
        assert_eq!(sorted(vec!["b", "A", "a", "B"]), ["a", "A", "b", "B"]);
        assert_eq!(sorted(vec!["file10", "file2", "file1"]), ["file1", "file10", "file2"]);
        assert_eq!(sorted(vec!["z", "é", "e", "f"]), ["e", "é", "f", "z"]);
        assert_eq!(sorted(vec!["_x", "-x", ".x", "x", "1x"]), ["_x", "-x", ".x", "1x", "x"]);
        assert_eq!(
            sorted(vec!["src/b.js", "src/a.js", "src", "Src/a.js"]),
            ["src", "src/a.js", "Src/a.js", "src/b.js"]
        );
        assert_eq!(
            sorted(vec![
                "a b", "a_b", "a-b", "ab", "a.b", "A.b", "a/b", "ı", "i", "İ", "I", "ş", "s", "ö", "o", "ü", "ç", "c",
                "ğ", "g", "日本", "αβ", "~x", "#x", "@x", "Ab", "aB",
            ]),
            [
                "@x", "#x", "~x", "a b", "a_b", "a-b", "a.b", "A.b", "a/b", "ab", "aB", "Ab", "c", "ç", "g", "ğ", "i",
                "I", "İ", "ı", "o", "ö", "s", "ş", "ü", "αβ", "日本",
            ]
        );
        assert_eq!(locale_compare("same", "same"), Ordering::Equal);
    }
}
