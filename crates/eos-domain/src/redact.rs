//! The shapes of secrets in text: the value of a secret-looking key
//! (`token=…`, `apiKey: …`), the credential after `Bearer` or `Basic`, and
//! an opaque run (an API key, a token, a cookie) with a piece of 20 or more
//! letters and digits mixed, which names (`064_genui_views`, `w-0j0ya9qd`)
//! and UUIDs never have. The log scrubber cuts them from every line, and the
//! outbound check holds a result that carries one. [`Scrubber`] cuts these
//! and the rest of what names the user (the home folder, URL queries, e-mail
//! addresses) from a line.

mod line;

pub use line::Scrubber;

/// What a secret is replaced with.
pub const REDACTED: &str = "<redacted>";

/// A piece of a run (between `-`, `_` and `.`) this long, with letters and digits, is
/// taken for a secret.
const OPAQUE: usize = 20;

/// Key names whose value is a secret (compared lowercased, `-` and `_` removed).
const SECRET_KEYS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "sessionkey",
    "cookie",
    "setcookie",
    "authorization",
    "auth",
    "credential",
    "credentials",
    "signature",
    "sig",
    "key",
    "privatekey",
];
/// A key ending in one of these is secret too (`refresh_token`, `client_secret`, `x-api-key`).
const SECRET_ENDINGS: &[&str] = &["token", "secret", "password", "apikey", "sessionkey", "cookie", "credential"];

/// Where one word of a text ends: a secret value runs to the next one.
pub fn word_break(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';')
}

/// The characters a token is made of.
fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '=' | '.')
}

/// The word before a credential: `Bearer` or `Basic`, in any case, maybe
/// with a `:` or `=` after it.
pub fn names_credential(word: &str) -> bool {
    let word = word.trim_end_matches([':', '=']);
    word.eq_ignore_ascii_case("bearer") || word.eq_ignore_ascii_case("basic")
}

fn secret_key(key: &str) -> bool {
    let key: String = key
        .trim_start_matches(|c: char| !c.is_ascii_alphanumeric())
        .chars()
        .filter(|c| !matches!(c, '-' | '_'))
        .collect::<String>()
        .to_ascii_lowercase();
    !key.is_empty() && (SECRET_KEYS.contains(&key.as_str()) || SECRET_ENDINGS.iter().any(|end| key.ends_with(end)))
}

/// `token=abc` / `apiKey:abc` → `token=<redacted>`; `None` when the word
/// sets no secret-looking key.
pub fn without_secret_value(word: &str) -> Option<String> {
    let at = word.find(['=', ':'])?;
    let (key, value) = (&word[..at], &word[at + 1..]);
    if value.is_empty() || value.starts_with("//") || !secret_key(key) {
        return None;
    }
    Some(format!("{}{REDACTED}", &word[..=at]))
}

fn opaque(run: &str) -> bool {
    let known = ["sk-ant-", "sk-", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "eos-sync1."];
    if known.iter().any(|prefix| run.starts_with(prefix) && run.len() >= prefix.len() + 16) {
        return true;
    }
    run.split(['-', '_', '.']).any(|piece| {
        piece.len() >= OPAQUE
            && piece.chars().any(|c| c.is_ascii_digit())
            && piece.chars().any(|c| c.is_ascii_alphabetic())
    })
}

/// Each opaque run in `word` becomes `<redacted>` (the key of a `key=value`
/// stays); `None` when the word holds none.
pub fn without_opaque_runs(word: &str) -> Option<String> {
    let mut out = String::new();
    let mut changed = false;
    let mut rest = word;
    while !rest.is_empty() {
        let start = rest.find(token_char).unwrap_or(rest.len());
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest.find(|c: char| !token_char(c)).unwrap_or(rest.len());
        let run = &rest[..end];
        // `key=value` pairs keep their key.
        let (lead, body) = match run.find('=') {
            Some(at) if at + 1 < run.len() => (&run[..=at], &run[at + 1..]),
            _ => ("", run),
        };
        if !body.is_empty() && opaque(body.trim_end_matches(['.', '='])) {
            out.push_str(lead);
            out.push_str(REDACTED);
            changed = true;
        } else {
            out.push_str(run);
        }
        rest = &rest[end..];
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_looking_key_loses_its_value() {
        assert_eq!(without_secret_value("token=abc123").as_deref(), Some("token=<redacted>"));
        assert_eq!(without_secret_value("x-api-key:zzz").as_deref(), Some("x-api-key:<redacted>"));
        assert_eq!(without_secret_value("refresh_token=r1").as_deref(), Some("refresh_token=<redacted>"));
        assert_eq!(without_secret_value("token="), None, "no value");
        assert_eq!(without_secret_value("url=https://x"), None, "not a secret's key");
        assert_eq!(without_secret_value("auth://host"), None, "a scheme");
    }

    #[test]
    fn a_credential_follows_bearer_or_basic() {
        for word in ["Bearer", "bearer", "BASIC:", "basic="] {
            assert!(names_credential(word), "{word}");
        }
        assert!(!names_credential("bearers"));
    }

    #[test]
    fn an_opaque_run_is_a_known_key_prefix_or_a_long_mixed_piece() {
        let cut = |word: &str| without_opaque_runs(word);
        assert_eq!(cut("sk-ant-api03-AbCdEfGhIjKlMnOpQrSt").as_deref(), Some(REDACTED));
        assert_eq!(cut("ghp_abcdefghijklmnop1234").as_deref(), Some(REDACTED));
        assert_eq!(cut("sid=a1b2c3d4e5f6a7b8c9d0e1").as_deref(), Some("sid=<redacted>"), "the key stays");
        assert_eq!(cut("3f2a9c1e7b4d4e8a9c2f0a1b2c3d4e5f6a7b8c9d").as_deref(), Some(REDACTED), "a hash has the shape");
        for plain in
            ["064_genui_views", "w-0j0ya9qd", "3f2a9c1e-7b4d-4e8a-9c2f-0a1b2c3d4e5f", "abcdefghijklmnopqrstuvwxyz"]
        {
            assert_eq!(cut(plain), None, "{plain}");
        }
    }
}
