//! Whether a proposed branch name is one git will take: the part of
//! `git check-ref-format` that matters for a branch.

/// `Err` carries the sentence the dashboard shows. The name is judged trimmed.
pub fn validate_branch_name(name: &str) -> Result<(), &'static str> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Branch name is empty.");
    }
    // Lengths count UTF-16 units, as the dashboard's copy of this rule does.
    if n.encode_utf16().count() > 255 {
        return Err("Branch name is too long.");
    }
    if n == "@" {
        return Err("Branch name cannot be '@'.");
    }
    if n.starts_with('/') || n.ends_with('/') {
        return Err("Cannot start or end with '/'.");
    }
    if n.starts_with('.') || n.ends_with('.') {
        return Err("Cannot start or end with '.'.");
    }
    if n.ends_with(".lock") {
        return Err("Cannot end with '.lock'.");
    }
    if n.contains("..") {
        return Err("Cannot contain '..'.");
    }
    if n.contains("//") {
        return Err("Cannot contain '//'.");
    }
    if n.contains("@{") {
        return Err("Cannot contain '@{'.");
    }
    if n.contains([' ', '~', '^', ':', '?', '*', '[', '\\']) {
        return Err("Contains a forbidden character (space or one of ~ ^ : ? * [ \\).");
    }
    if n.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
        return Err("Contains a control character.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_branch_names() {
        for ok in ["main", "feature/login", "release-2.0", "fix_123", "user/feat/x", "  main  "] {
            assert_eq!(validate_branch_name(ok), Ok(()), "{ok}");
        }
    }

    #[test]
    fn rejects_empty_names() {
        assert_eq!(validate_branch_name(""), Err("Branch name is empty."));
        assert_eq!(validate_branch_name("   "), Err("Branch name is empty."));
    }

    #[test]
    fn rejects_forbidden_characters() {
        for bad in ["has space", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"] {
            assert!(validate_branch_name(bad).is_err(), "{bad}");
        }
        assert_eq!(validate_branch_name("a\u{7}b"), Err("Contains a control character."));
    }

    #[test]
    fn rejects_ref_format_edge_cases() {
        for bad in ["/lead", "trail/", ".dot", "dot.", "feat.lock", "a..b", "a//b", "a@{b", "@"] {
            assert!(validate_branch_name(bad).is_err(), "{bad}");
        }
        assert_eq!(validate_branch_name(&"x".repeat(256)), Err("Branch name is too long."));
    }
}
