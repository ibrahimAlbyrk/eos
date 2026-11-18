//! The last line of defence before a line reaches a file: what the call sites must never
//! log (`ARCHITECTURE.md`, "What may be logged") is cut here too, in case a library's
//! error text carries it.
//!
//! - the user's home folder becomes `~` (it names the user);
//! - a URL keeps its scheme, host and path: user info, query and fragment are cut;
//! - an e-mail address becomes `<email>`;
//! - every shape of secret `eos_domain::redact` knows becomes `<redacted>`: the value of a
//!   secret-looking key (`token=…`, `apiKey: …`, `Bearer …`) and an opaque run (an API
//!   key, a token, a cookie).

use std::borrow::Cow;
use std::path::Path;

use eos_domain::redact::{REDACTED, names_credential, without_opaque_runs, without_secret_value, word_break};

/// Scrubs lines for one user's home folder.
#[derive(Debug, Clone, Default)]
pub struct Scrubber {
    home: Option<String>,
}

fn email_local(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
}

fn email_domain(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-')
}

impl Scrubber {
    /// `home`: the user's home folder, replaced by `~` wherever it appears.
    pub fn new(home: Option<&Path>) -> Self {
        let home = home.map(|h| h.to_string_lossy().trim_end_matches('/').to_owned()).filter(|h| h.len() > 1);
        Self { home }
    }

    pub fn scrub<'a>(&self, line: &'a str) -> Cow<'a, str> {
        let homed = match &self.home {
            Some(home) if line.contains(home.as_str()) => Cow::Owned(replace_home(line, home)),
            _ => Cow::Borrowed(line),
        };
        let mut out = String::with_capacity(homed.len());
        let mut changed = matches!(homed, Cow::Owned(_));
        let mut previous = "";
        let mut rest: &str = &homed;
        while !rest.is_empty() {
            let start = rest.find(|c: char| !word_break(c)).unwrap_or(rest.len());
            out.push_str(&rest[..start]);
            rest = &rest[start..];
            if rest.is_empty() {
                break;
            }
            let end = rest.find(word_break).unwrap_or(rest.len());
            let word = &rest[..end];
            let clean = if names_credential(previous) { Cow::Borrowed(REDACTED) } else { scrub_word(word) };
            changed |= clean != word;
            out.push_str(&clean);
            previous = word;
            rest = &rest[end..];
        }
        if changed { Cow::Owned(out) } else { homed }
    }
}

fn replace_home(line: &str, home: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find(home) {
        let after = &rest[at + home.len()..];
        out.push_str(&rest[..at]);
        // `/Users/al` is not the home of `/Users/alice`.
        if after.chars().next().is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
            out.push('~');
        } else {
            out.push_str(home);
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

fn scrub_word(word: &str) -> Cow<'_, str> {
    let mut word = Cow::Borrowed(word);
    if let Some(cut) = without_query(&word) {
        word = Cow::Owned(cut);
    }
    if let Some(cut) = without_user_info(&word) {
        word = Cow::Owned(cut);
    }
    if let Some(cut) = without_secret_value(&word) {
        word = Cow::Owned(cut);
    }
    if let Some(cut) = without_emails(&word) {
        word = Cow::Owned(cut);
    }
    if let Some(cut) = without_opaque_runs(&word) {
        word = Cow::Owned(cut);
    }
    word
}

/// `https://h/p?x=1#y` → `https://h/p?<query>`; also a path's `?a=b`.
fn without_query(word: &str) -> Option<String> {
    let url = word.contains("://");
    let mut cut = word.find('?').filter(|&at| {
        let after = &word[at + 1..];
        !after.is_empty() && (url || word.starts_with('/') || after.contains('='))
    });
    let mut tail = "?<query>";
    if cut.is_none() && url {
        cut = word.find('#').filter(|&at| at + 1 < word.len());
        tail = "#<fragment>";
    }
    let at = cut?;
    Some(format!("{}{tail}", &word[..at]))
}

/// `https://user:pass@host/…` → `https://host/…`.
fn without_user_info(word: &str) -> Option<String> {
    let scheme_end = word.find("://")? + 3;
    let authority_end = word[scheme_end..].find('/').map_or(word.len(), |i| scheme_end + i);
    let at = word[scheme_end..authority_end].rfind('@')? + scheme_end;
    Some(format!("{}{}", &word[..scheme_end], &word[at + 1..]))
}

fn without_emails(word: &str) -> Option<String> {
    if !word.contains('@') {
        return None;
    }
    let mut out = String::new();
    let mut last = 0;
    for (at, _) in word.match_indices('@') {
        if at < last {
            continue;
        }
        let start = word[last..at].rfind(|c: char| !email_local(c)).map_or(last, |i| last + i + 1);
        let mut end = word[at + 1..].find(|c: char| !email_domain(c)).map_or(word.len(), |i| at + 1 + i);
        while end > at + 1 && word[..end].ends_with(['.', '-']) {
            end -= 1;
        }
        let domain = &word[at + 1..end];
        let tld_ok = domain.rsplit_once('.').is_some_and(|(name, tld)| {
            !name.is_empty() && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())
        });
        if start < at && tld_ok {
            out.push_str(&word[last..start]);
            out.push_str("<email>");
            last = end;
        }
    }
    if last == 0 {
        return None;
    }
    out.push_str(&word[last..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrub(line: &str) -> String {
        Scrubber::new(Some(Path::new("/Users/alice"))).scrub(line).into_owned()
    }

    #[test]
    fn plain_lines_pass_unchanged() {
        for line in [
            "2026-11-14T20:30:01.123456Z  INFO eos_sessions::service: turn ended worker_id=w-0j0ya9qd outcome=ended ms=1234",
            "request failed method=POST route=/workers/:id/message status=500 ms=12",
            "a session 3f2a9c1e-7b4d-4e8a-9c2f-0a1b2c3d4e5f started",
            "why? because.",
            "device connected device_id=ABCD-1234",
            "error=the database is locked code=E_BUSY",
            "migrations ran applied=[\"006_workers_add_tokens_cache_read\", \"067_engine_sessions\"]",
            "branch eos/w-0j0ya9qd-fix-the-login-button-on-mobile-2",
        ] {
            assert_eq!(scrub(line), line);
            assert!(matches!(Scrubber::new(Some(Path::new("/Users/alice"))).scrub(line), Cow::Borrowed(_)));
        }
    }

    #[test]
    fn the_home_folder_becomes_a_tilde() {
        assert_eq!(scrub("path=/Users/alice/Projects/x/a.rs"), "path=~/Projects/x/a.rs");
        assert_eq!(scrub("dir /Users/alice"), "dir ~");
        assert_eq!(scrub("other /Users/alicea/x"), "other /Users/alicea/x");
    }

    #[test]
    fn urls_keep_their_host_and_path_only() {
        assert_eq!(
            scrub("GET https://api.example.com/v1/x?key=abc&b=2 failed"),
            "GET https://api.example.com/v1/x?<query> failed"
        );
        assert_eq!(scrub("url=https://me:pw@h.example/p"), "url=https://h.example/p");
        assert_eq!(scrub("(https://claude.ai/login#code=xyz)"), "(https://claude.ai/login#<fragment>)");
        assert_eq!(scrub("path=/api/files?path=/secret"), "path=/api/files?<query>");
    }

    #[test]
    fn emails_and_secrets_are_cut() {
        assert_eq!(scrub("signed in as alice.smith+x@example.co.uk."), "signed in as <email>.");
        assert_eq!(scrub("token=abc123 apiKey:zzz"), "token=<redacted> apiKey:<redacted>");
        assert_eq!(scrub("authorization: Bearer abc.def"), "authorization: Bearer <redacted>");
        assert_eq!(scrub("x refresh_token=r1 client_secret=s"), "x refresh_token=<redacted> client_secret=<redacted>");
        assert_eq!(scrub("key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt leaked"), "key <redacted> leaked");
        assert_eq!(scrub("ui 9f8e7d6c5b4a39281706f5e4d3c2b1a0aa55bb66cc77dd88"), "ui <redacted>");
        assert_eq!(scrub("cookie sessionKey=sk-ant-sid01-abcdefabcdefabcdef"), "cookie sessionKey=<redacted>");
        assert_eq!(scrub("sync eos-sync1.relay.example.Zm9vYmFyYmF6cXV4eHl6MTIz"), "sync <redacted>");
        assert_eq!(scrub("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"), "jwt <redacted>");
        assert_eq!(scrub("sha 3f2a9c1e7b4d4e8a9c2f0a1b2c3d4e5f6a7b8c9d"), "sha <redacted>");
    }
}
