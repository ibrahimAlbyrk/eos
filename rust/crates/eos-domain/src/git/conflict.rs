//! Reading git's two-letter status of an unmerged file.

use eos_contracts::ConflictKind;

/// The status codes git gives a file that is in conflict. The conflict count
/// and the conflict list both ask here, so they cannot disagree.
pub fn is_unmerged_code(xy: &str) -> bool {
    matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

/// What kind of conflict a status code is. `Content` is resolved hunk by
/// hunk; the others are a keep-or-remove choice for the whole file.
pub fn classify_conflict(xy: &str) -> ConflictKind {
    match xy {
        "DU" => ConflictKind::OursDeleted,
        "UD" => ConflictKind::TheirsDeleted,
        "AU" => ConflictKind::OursAdded,
        "UA" => ConflictKind::TheirsAdded,
        "DD" => ConflictKind::BothDeleted,
        _ => ConflictKind::Content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seven_unmerged_codes_and_no_other() {
        for xy in ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] {
            assert!(is_unmerged_code(xy), "{xy}");
        }
        for xy in [" M", "M ", "??", "A ", "R ", "", "U"] {
            assert!(!is_unmerged_code(xy), "{xy}");
        }
    }

    #[test]
    fn each_code_has_its_kind() {
        assert_eq!(classify_conflict("UU"), ConflictKind::Content);
        assert_eq!(classify_conflict("AA"), ConflictKind::Content);
        assert_eq!(classify_conflict("DU"), ConflictKind::OursDeleted);
        assert_eq!(classify_conflict("UD"), ConflictKind::TheirsDeleted);
        assert_eq!(classify_conflict("AU"), ConflictKind::OursAdded);
        assert_eq!(classify_conflict("UA"), ConflictKind::TheirsAdded);
        assert_eq!(classify_conflict("DD"), ConflictKind::BothDeleted);
    }
}
