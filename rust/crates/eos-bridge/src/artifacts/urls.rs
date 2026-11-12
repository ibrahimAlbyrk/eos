//! Which pages an artifact view may show (`app/src/main/artifacts/viewerUrls.ts`,
//! `sessions.ts`): only claude.ai's artifact viewer. Its sign-in pages mean the profile
//! needs a sign-in.

/// The site artifact views show. claude.ai in the app; a local page standing in for it in
/// a test run (the shell accepts another origin only in a build with the dev proxy).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Viewer {
    /// `https://claude.ai`, or a test's `http://127.0.0.1:<port>`: no trailing slash.
    origin: String,
}

const CLAUDE: &str = "https://claude.ai";
const PREVIEW: &str = "https://preview.claude.ai";

fn path_of<'a>(url: &'a str, origin: &str) -> Option<&'a str> {
    let rest = url.strip_prefix(origin)?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    rest.starts_with('/').then_some(rest)
}

fn starts_any(path: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| path.starts_with(p))
}

/// `^/(?:login|logout|magic-link)(?:/|$)`
fn sign_in_path(path: &str, names: &[&str]) -> bool {
    names.iter().any(|name| {
        path.strip_prefix('/')
            .and_then(|p| p.strip_prefix(name))
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

impl Default for Viewer {
    fn default() -> Self {
        Self { origin: CLAUDE.to_owned() }
    }
}

impl Viewer {
    /// A stand-in for claude.ai at `origin` (a test run's local server).
    pub fn at(origin: &str) -> Self {
        Self { origin: origin.trim_end_matches('/').to_owned() }
    }

    fn path<'a>(&self, url: &'a str) -> Option<&'a str> {
        path_of(url, &self.origin).or_else(|| if self.origin == CLAUDE { path_of(url, PREVIEW) } else { None })
    }

    /// The page an artifact view loads: the viewer of `slug`, the artifact's uuid.
    pub fn viewer_url(&self, slug: &str) -> String {
        let claude = eos_contracts::artifact_viewer_url(slug);
        match claude.strip_prefix(CLAUDE) {
            Some(path) => format!("{}{path}", self.origin),
            None => claude,
        }
    }

    pub fn login_url(&self) -> String {
        format!("{}/login", self.origin)
    }

    /// Where the sign-in cookie lives.
    pub fn cookie_url(&self) -> String {
        format!("{}/", self.origin)
    }

    pub fn is_viewer(&self, url: &str) -> bool {
        self.path(url).is_some_and(|p| starts_any(p, &["/artifact/", "/code/artifact/", "/code/frame/"]))
    }

    pub fn is_login(&self, url: &str) -> bool {
        self.path(url).is_some_and(|p| sign_in_path(p, &["login", "logout"]))
    }

    /// Still on a sign-in page (or off the site): a cookie alone is not a finished sign-in.
    pub fn on_sign_in_page(&self, url: &str) -> bool {
        self.path(url).is_none_or(|p| sign_in_path(p, &["login", "logout", "magic-link"]))
    }
}

pub fn is_web(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLUG: &str = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn only_the_viewer_paths_of_claude_ai_are_the_viewer() {
        let v = Viewer::default();
        assert_eq!(v.viewer_url(SLUG), "https://claude.ai/artifact/2NC37Mk7spnA7bv13mCd5k");
        assert!(v.is_viewer("https://claude.ai/artifact/2NC37Mk7spnA7bv13mCd5k"));
        assert!(v.is_viewer("https://preview.claude.ai/code/artifact/x?y=1"));
        assert!(v.is_viewer("https://claude.ai/code/frame/abc"));
        assert!(!v.is_viewer("https://claude.ai/chat/abc"));
        assert!(!v.is_viewer("http://claude.ai/artifact/abc"));
        assert!(!v.is_viewer("https://claude.ai.evil.com/artifact/abc"));
        assert!(!v.is_viewer("https://evil.com/https://claude.ai/artifact/x"));
    }

    #[test]
    fn sign_in_pages_are_told_apart() {
        let v = Viewer::default();
        assert!(v.is_login("https://claude.ai/login"));
        assert!(v.is_login("https://claude.ai/login/oauth?x"));
        assert!(v.is_login("https://claude.ai/logout"));
        assert!(!v.is_login("https://claude.ai/loginx"));
        assert!(!v.is_login("https://claude.ai/magic-link"));
        assert!(v.on_sign_in_page("https://claude.ai/magic-link#t"));
        assert!(v.on_sign_in_page("https://accounts.google.com/o/oauth2"));
        assert!(!v.on_sign_in_page("https://claude.ai/new"));
        assert_eq!(v.login_url(), "https://claude.ai/login");
        assert_eq!(v.cookie_url(), "https://claude.ai/");
    }

    #[test]
    fn a_test_origin_stands_in_for_claude_ai_and_nothing_else_does() {
        let v = Viewer::at("http://127.0.0.1:7777/");
        assert_eq!(v.viewer_url(SLUG), "http://127.0.0.1:7777/artifact/2NC37Mk7spnA7bv13mCd5k");
        assert!(v.is_viewer("http://127.0.0.1:7777/artifact/2NC37Mk7spnA7bv13mCd5k"));
        assert!(!v.is_viewer("https://claude.ai/artifact/2NC37Mk7spnA7bv13mCd5k"));
        assert!(!v.is_viewer("http://127.0.0.1:7778/artifact/x"));
        assert!(v.is_login("http://127.0.0.1:7777/login"));
        assert!(is_web("HTTPS://x") && is_web("http://x") && !is_web("mailto:x") && !is_web("javascript:x"));
    }
}
