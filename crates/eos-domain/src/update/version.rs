//! Release versions are `major.minor.patch` (`AppVersion`, `release.sh`).

use std::cmp::Ordering;

/// One dotted part as JavaScript's `Number()` reads it, for the strings a
/// version can hold: digits are their value, nothing is 0, anything else is
/// not a number.
fn part(text: Option<&str>) -> Option<f64> {
    let text = text?;
    if text.is_empty() {
        return Some(0.0);
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return Some(f64::NAN);
    }
    text.parse().ok()
}

/// Compares the first three parts numerically.
///
/// A part that is not a number compares as "greater", whichever side it is
/// on, as today's comparison does: such a string never reaches this from the
/// feed (the pointer's version is checked first), only from a damaged
/// `last-version` file.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (mut pa, mut pb) = (a.split('.'), b.split('.'));
    for _ in 0..3 {
        match (part(pa.next()), part(pb.next())) {
            (None, None) => {}
            (Some(x), Some(y)) if x == y => {}
            (Some(x), Some(y)) if x < y => return Ordering::Less,
            _ => return Ordering::Greater,
        }
    }
    Ordering::Equal
}

/// An update only ever moves forward: a replayed old pointer offers nothing.
pub fn is_newer_version(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) == Ordering::Greater
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn major_minor_patch_compare_numerically() {
        assert_eq!(compare_versions("0.1.10", "0.1.9"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.0", "0.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0.7", "1.0.0.9"), Ordering::Equal, "only three parts count");
    }

    #[test]
    fn only_versions_above_the_installed_one_are_newer() {
        assert!(is_newer_version("0.1.3", "0.1.2"));
        assert!(!is_newer_version("0.1.2", "0.1.2"));
        assert!(!is_newer_version("0.1.1", "0.1.2"));
    }

    #[test]
    fn a_part_that_is_no_number_compares_as_javascript_does() {
        // NaN is neither equal nor less: the first side "wins" either way.
        assert_eq!(compare_versions("0.1.x", "0.1.2"), Ordering::Greater);
        assert_eq!(compare_versions("0.1.2", "0.1.x"), Ordering::Greater);
        assert_eq!(compare_versions("0.1", "0.1"), Ordering::Equal);
        assert_eq!(compare_versions("0.1", "0.1.0"), Ordering::Greater);
    }
}
