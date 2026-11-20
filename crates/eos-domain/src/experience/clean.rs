//! What a note may hold before it is stored. Every note, evidence summary
//! and example passes [`clean`]: the home folder, URL queries and e-mail
//! addresses are cut as the log file cuts them, and a text that carried a
//! secret is dropped whole, since what is left was about the secret. A note
//! or guess about the user also passes [`sensitive`]: health, money,
//! relationships, religion and politics are never kept about anyone.

use crate::redact::{REDACTED, Scrubber};

/// Why a text was not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dropped {
    /// It held something shaped like a secret.
    Secret,
    /// It names a sensitive personal matter.
    Sensitive,
    /// Nothing is left.
    Empty,
}

impl Dropped {
    pub fn as_str(self) -> &'static str {
        match self {
            Dropped::Secret => "secret",
            Dropped::Sensitive => "sensitive",
            Dropped::Empty => "empty",
        }
    }
}

/// `text` as it may be stored, or why it may not.
pub fn clean(scrubber: &Scrubber, text: &str) -> Result<String, Dropped> {
    let cut = scrubber.scrub(text);
    if cut.matches(REDACTED).count() > text.matches(REDACTED).count() {
        return Err(Dropped::Secret);
    }
    let cut = cut.trim();
    if cut.is_empty() { Err(Dropped::Empty) } else { Ok(cut.to_owned()) }
}

/// [`clean`], and no sensitive personal matter: for a note or a guess about
/// the user.
pub fn clean_about_user(scrubber: &Scrubber, text: &str) -> Result<String, Dropped> {
    let text = clean(scrubber, text)?;
    if sensitive(&text) { Err(Dropped::Sensitive) } else { Ok(text) }
}

/// Words that name a sensitive matter, in English and Turkish. A word of four
/// letters or more also matches as the start of a longer one (`prayer`,
/// `ilaçlar`); a shorter one only alone.
const SENSITIVE: &[&str] = &[
    // health
    "health",
    "illness",
    "disease",
    "diagnos",
    "depress",
    "anxiety",
    "therap",
    "medication",
    "pregnan",
    "cancer",
    "adhd",
    "autism",
    "autistic",
    "disorder",
    "hastalık",
    "hasta",
    "ilaç",
    "terapi",
    "depresyon",
    "teşhis",
    "hamile",
    // money
    "salary",
    "debt",
    "loan",
    "mortgage",
    "income",
    "bankrupt",
    "savings",
    "maaş",
    "borç",
    "kredi",
    "gelir",
    "iflas",
    // relationships
    "divorce",
    "girlfriend",
    "boyfriend",
    "wife",
    "husband",
    "dating",
    "breakup",
    "marriage",
    "boşan",
    "sevgili",
    "evlilik",
    // religion
    "religio",
    "church",
    "mosque",
    "synagogue",
    "pray",
    "faith",
    "atheis",
    "muslim",
    "christian",
    "jewish",
    "din",
    "dini",
    "namaz",
    "cami",
    "kilise",
    "inanç",
    "oruç",
    // politics
    "politic",
    "election",
    "vote",
    "voting",
    "democrat",
    "republican",
    "conservative",
    "liberal",
    "siyas",
    "seçim",
    "oy",
    "parti",
];

/// The text names a sensitive personal matter.
pub fn sensitive(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .any(|word| SENSITIVE.iter().any(|s| if s.chars().count() >= 4 { word.starts_with(s) } else { word == *s }))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn scrubber() -> Scrubber {
        Scrubber::new(Some(Path::new("/Users/alice")))
    }

    #[test]
    fn home_queries_and_emails_are_cut_and_the_rest_kept() {
        let s = scrubber();
        assert_eq!(
            clean(&s, " Edit /Users/alice/game/Assets/a.cs, not the copy. ").as_deref(),
            Ok("Edit ~/game/Assets/a.cs, not the copy.")
        );
        assert_eq!(
            clean(&s, "Ask bob.smith@example.com before calling https://api.example.com/v2/x?key=1").as_deref(),
            Ok("Ask <email> before calling https://api.example.com/v2/x?<query>")
        );
        assert_eq!(
            clean(&s, "Use pnpm, not npm, in game-client.").as_deref(),
            Ok("Use pnpm, not npm, in game-client.")
        );
    }

    #[test]
    fn a_text_that_held_a_secret_is_dropped() {
        let s = scrubber();
        for planted in [
            "The deploy uses token=abc123 for staging",
            "Set ANTHROPIC key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt in the env",
            "curl with Authorization: Bearer xyz.abc",
            "ghp_abcdefghijklmnop1234 is the bot's",
        ] {
            assert_eq!(clean(&s, planted), Err(Dropped::Secret), "{planted}");
        }
        assert_eq!(clean(&s, "the marker <redacted> is literal").as_deref(), Ok("the marker <redacted> is literal"));
        assert_eq!(clean(&s, "   "), Err(Dropped::Empty));
    }

    #[test]
    fn sensitive_matters_are_never_kept_about_the_user() {
        let s = scrubber();
        for text in [
            "The user has ADHD and prefers short answers",
            "Their salary is due on Fridays",
            "Mentions their divorce often",
            "Prays before meetings",
            "Votes conservative",
            "Kullanıcı depresyon ilaçları kullanıyor",
            "Maaşı ayın 15'inde yatıyor",
            "Namaz vaktinde toplantı istemiyor",
        ] {
            assert_eq!(clean_about_user(&s, text), Err(Dropped::Sensitive), "{text}");
        }
        for text in [
            "Prefers short answers in English",
            "Works on the game client in Unity",
            "Oyun motoru Unity",
            "Kendi dinamik testlerini yazıyor",
            "Uses a party-mode flag in tests",
        ] {
            assert!(clean_about_user(&s, text).is_ok(), "{text}");
        }
    }
}
