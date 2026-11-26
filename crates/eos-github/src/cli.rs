//! The seam to the GitHub CLI (`gh`), whose sign-in the capability uses: an
//! organisation that limits third-party apps still lets `gh` in, so what
//! works in the user's terminal works here. [`Cli`] finds or installs `gh`,
//! reads the token it keeps and runs its own sign-in; [`Gh`](crate::Gh) is
//! the real one, and only the host hands it in, so a test, a dev run or a
//! replay never runs `gh` or touches the user's sign-in.

use std::fmt;

use eos_core::BoxFuture;
use zeroize::Zeroizing;

/// Why `gh` gave no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CliError {
    /// `gh` is not on this computer and could not be installed.
    Missing,
    /// `gh` has no sign-in for the account asked for.
    SignedOut,
    /// The sign-in's code ran out before it was entered.
    Expired,
    /// `gh` failed, or said something this does not read.
    Failed,
}

/// A sign-in `gh` runs: the code the user enters on GitHub's page, and the
/// wait for `gh` to end. Dropping `done` ends `gh`.
pub struct Login {
    pub user_code: Zeroizing<String>,
    pub verification_uri: String,
    pub done: BoxFuture<'static, Result<(), CliError>>,
}

impl fmt::Debug for Login {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Login").field("verification_uri", &self.verification_uri).finish_non_exhaustive()
    }
}

pub trait Cli: Send + Sync {
    /// Makes sure `gh` is on this computer, installing it when it is not.
    fn ensure(&self) -> BoxFuture<'_, Result<(), CliError>>;
    /// The token `gh` keeps for `account` on github.com, or for its active
    /// account.
    fn token<'a>(&'a self, account: Option<&'a str>) -> BoxFuture<'a, Result<Zeroizing<String>, CliError>>;
    /// Starts `gh`'s sign-in to github.com; the account it signs in becomes
    /// the active one.
    fn login(&self) -> BoxFuture<'_, Result<Login, CliError>>;
}

/// The code and the page in what `gh auth login` prints before it waits:
/// the first `XXXX-XXXX` and the first `https://` address. The wording
/// around them differs between versions of `gh`.
pub(crate) fn read_prompt(printed: &str) -> Option<(String, String)> {
    let words = || printed.split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | ','));
    let is_code = |word: &&str| {
        let mut halves = word.split('-');
        let half = |part: Option<&str>| {
            part.is_some_and(|part| {
                part.len() == 4 && part.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            })
        };
        half(halves.next()) && half(halves.next()) && halves.next().is_none()
    };
    let code = words().find(is_code)?;
    let page = words().find(|word| word.starts_with("https://"))?;
    Some((code.to_owned(), page.trim_end_matches('.').to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_and_the_page_are_read_whatever_the_words_around_them() {
        let page = "https://github.com/login/device".to_owned();
        let now = "\n! One-time code (WDJB-MJHT) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
        assert_eq!(read_prompt(now), Some(("WDJB-MJHT".to_owned(), page.clone())));
        let before = "! First copy your one-time code: 12AB-9XYZ\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
        assert_eq!(read_prompt(before), Some(("12AB-9XYZ".to_owned(), page)));
        assert_eq!(read_prompt("! One-time code (WDJB-MJHT) copied to clipboard\n"), None, "the page is not there yet");
        assert_eq!(read_prompt("error connecting to github.com: https://github.com"), None);
    }
}
