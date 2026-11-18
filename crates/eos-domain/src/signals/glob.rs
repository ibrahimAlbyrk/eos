//! Path globs in rules (`Assets/Scripts/**`) and folder triggers (`*.pdf`):
//! `*` matches inside one part of a path, `**` across parts, `**/` none or
//! more whole folders, `?` one character that is not `/`. Every other
//! character matches itself, case included.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Char(char),
    One,
    Star,
    Stars,
    Folders,
}

fn tokens(pattern: &str) -> Vec<Token> {
    let mut chars = pattern.chars().peekable();
    let mut tokens = Vec::new();
    while let Some(c) = chars.next() {
        tokens.push(match c {
            '?' => Token::One,
            '*' => match chars.next_if_eq(&'*') {
                None => Token::Star,
                Some(_) if chars.next_if_eq(&'/').is_some() => Token::Folders,
                Some(_) => Token::Stars,
            },
            c => Token::Char(c),
        });
    }
    tokens
}

/// Whether `text` matches `pattern` whole. Each step of the pattern keeps
/// which lengths of the text it can reach, so a pattern with many stars
/// takes time in proportion to its length times the text's.
pub fn matches(pattern: &str, text: &str) -> bool {
    let text: Vec<char> = text.chars().collect();
    let mut reach = vec![false; text.len() + 1];
    reach[0] = true;
    for token in tokens(pattern) {
        let mut next = vec![false; text.len() + 1];
        let mut reached_before = false;
        for at in 0..=text.len() {
            let previous = at.checked_sub(1).map(|i| text[i]);
            next[at] = match token {
                Token::Char(c) => previous == Some(c) && reach[at - 1],
                Token::One => previous.is_some_and(|p| p != '/') && reach[at - 1],
                Token::Star => reach[at] || (previous.is_some_and(|p| p != '/') && next[at - 1]),
                Token::Stars => reach[at] || (previous.is_some() && next[at - 1]),
                Token::Folders => reach[at] || (previous == Some('/') && reached_before),
            };
            reached_before |= reach[at];
        }
        reach = next;
    }
    reach[text.len()]
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn a_star_stays_inside_one_part_of_a_path() {
        assert!(matches("*.cs", "Player.cs"));
        assert!(!matches("*.cs", "Scripts/Player.cs"));
        assert!(matches("Assets/*/Player.cs", "Assets/Scripts/Player.cs"));
        assert!(!matches("Assets/*/Player.cs", "Assets/Scripts/Net/Player.cs"));
        assert!(matches("*", ""));
        assert!(!matches("*.cs", "Player.csx"));
    }

    #[test]
    fn two_stars_cross_folders() {
        assert!(matches("Assets/Scripts/**", "Assets/Scripts/Net/Client.cs"));
        assert!(matches("Assets/Scripts/**", "Assets/Scripts/Player.cs"));
        assert!(!matches("Assets/Scripts/**", "Assets/Art/Player.png"));
        assert!(!matches("Assets/Scripts/**", "Assets/Scripts"));
        // `**/` is none or more whole folders.
        assert!(matches("**/*.cs", "Player.cs"));
        assert!(matches("**/*.cs", "Assets/Scripts/Player.cs"));
        assert!(matches("Assets/**/Player.cs", "Assets/Player.cs"));
        assert!(matches("Assets/**/Player.cs", "Assets/A/B/Player.cs"));
        assert!(!matches("Assets/**/Player.cs", "Assets/APlayer.cs"));
        assert!(matches("src/**.rs", "src/a/b.rs"));
    }

    #[test]
    fn a_question_mark_is_one_character_but_not_a_slash() {
        assert!(matches("v?.txt", "v1.txt"));
        assert!(matches("v?.txt", "vé.txt"));
        assert!(!matches("v?.txt", "v12.txt"));
        assert!(!matches("a?b", "a/b"));
    }

    #[test]
    fn everything_else_matches_itself_case_included() {
        assert!(matches("README.md", "README.md"));
        assert!(!matches("README.md", "readme.md"));
        assert!(matches("[draft].md", "[draft].md"));
        assert!(!matches("a", "ab") && !matches("ab", "a"));
    }

    #[test]
    fn many_stars_on_a_long_path_stay_quick() {
        let path = format!("{}b", "a".repeat(4_000));
        assert!(!matches(&"*a".repeat(50), &format!("{path}c")));
        assert!(matches(&format!("{}b", "*a".repeat(50)), &path));
    }
}
