//! A routine's slug (`/run pr-review`, `eos run pr-review`, 01 G35): made
//! from its name at creation, unique among the routines that can still come
//! back.

/// The slug `name` makes: lowercase ASCII letters and digits, words joined
/// by `-`; `routine` when nothing of the name is left.
pub fn of_name(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() { "routine".to_owned() } else { slug.to_owned() }
}

/// `base`, or `base-2`, `base-3`… the first that `taken` does not hold.
pub fn unique(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_owned();
    }
    (2..).map(|n| format!("{base}-{n}")).find(|slug| !taken(slug)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slug_is_the_names_words_in_lowercase_joined_by_dashes() {
        assert_eq!(of_name("PR Review"), "pr-review");
        assert_eq!(of_name("  Morning   Paper! "), "morning-paper");
        assert_eq!(of_name("Release Notes v2.1"), "release-notes-v2-1");
        assert_eq!(of_name("Çay ☕"), "ay");
        assert_eq!(of_name("☕"), "routine");
    }

    #[test]
    fn a_taken_slug_gets_the_first_free_number() {
        let taken = ["pr-review", "pr-review-2"];
        assert_eq!(unique("pr-review", |slug| taken.contains(&slug)), "pr-review-3");
        assert_eq!(unique("paper", |slug| taken.contains(&slug)), "paper");
    }
}
