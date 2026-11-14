//! The popups of the claude.ai sign-in window: which open, and where they may go.
//!
//! claude.ai's "Continue with Google" is Google Identity Services' code client in popup
//! mode: the login page calls `window.open("https://accounts.google.com/o/oauth2/v2/auth?…
//! &display=popup&redirect_uri=gis_transform…", "g_auth_code_window_…", "width=…")`, with no
//! intermediate page, and the popup hands the code back to its opener with `postMessage`.
//! "Continue with Apple" is a redirect of the window itself and email is a link or a code:
//! neither opens a popup. So only that one endpoint opens, and inside the popup only
//! Google's own sign-in hosts load (see [`may_visit`]).

use tauri::Url;

/// The host Google's sign-in popup opens on, and the path of its OAuth endpoints.
const GOOGLE_ACCOUNTS: &str = "accounts.google.com";
const OAUTH_PATH: &str = "/o/oauth2/";

/// A plain `https` URL on the default port, without a user name or password: what every
/// rule below asks for before it looks at the host.
fn plain_https(url: &Url) -> bool {
    url.scheme() == "https" && url.port().is_none() && url.username().is_empty() && url.password().is_none()
}

/// A test run's stand-in for the identity provider: the same origin, exactly.
fn same_origin(url: &Url, stand_in: Option<&Url>) -> bool {
    stand_in.is_some_and(|s| url.origin() == s.origin())
}

/// Whether a popup the sign-in page asks for opens: Google's OAuth endpoint only.
pub(crate) fn opens(url: &Url, stand_in: Option<&Url>) -> bool {
    same_origin(url, stand_in)
        || (plain_https(url) && url.host_str() == Some(GOOGLE_ACCOUNTS) && url.path().starts_with(OAUTH_PATH))
}

/// `accounts.google.<country>`: Google's sign-in sets its cookie on the user's country
/// domain on the way (`/accounts/SetSID`), as `accounts.google.com.tr`, `.co.uk` or `.de`.
fn google_country_accounts(host: &str) -> bool {
    let Some(country) = host.strip_prefix("accounts.google.") else { return false };
    let two = |s: &str| s.len() == 2 && s.bytes().all(|b| b.is_ascii_lowercase());
    match country.split_once('.') {
        None => two(country),
        Some((second, cc)) => matches!(second, "com" | "co") && two(cc),
    }
}

/// Where the popup's own page may go. Google's sign-in moves between a few of its hosts:
/// `accounts.google.com` (choosing the account, the password, the second step, consent and
/// the `gsi/transform` page that answers the opener), `accounts.youtube.com` and
/// `accounts.google.<country>` (the cross-domain sign-in cookie, `/accounts/SetSID` and
/// `CheckCookie`), `gds.google.com` (the prompts Google may show after a sign-in, such as
/// checking the recovery options). Nothing else: a Workspace account that signs in through
/// its company's own identity provider leaves these hosts and is not followed.
pub(crate) fn may_visit(url: &Url, stand_in: Option<&Url>) -> bool {
    if url.as_str() == "about:blank" || same_origin(url, stand_in) {
        return true;
    }
    let Some(host) = url.host_str().filter(|_| plain_https(url)) else { return false };
    matches!(host, GOOGLE_ACCOUNTS | "accounts.youtube.com" | "gds.google.com") || google_country_accounts(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap_or_else(|e| panic!("{s}: {e}"))
    }

    const AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=gis_transform";

    #[test]
    fn only_googles_oauth_endpoint_opens() {
        assert!(opens(&url(AUTH), None));
        assert!(opens(&url("https://ACCOUNTS.google.com/o/oauth2/v2/auth"), None));
        assert!(opens(&url("https://accounts.google.com:443/o/oauth2/v2/auth"), None));
        for denied in [
            "http://accounts.google.com/o/oauth2/v2/auth",
            "https://accounts.google.com/signin/v2/identifier",
            "https://accounts.google.com/gsi/select",
            "https://accounts.google.com:8443/o/oauth2/v2/auth",
            "https://accounts.google.com.evil.example/o/oauth2/v2/auth",
            "https://accounts.google.com./o/oauth2/v2/auth",
            "https://evil.example/accounts.google.com/o/oauth2/v2/auth",
            "https://accounts.google.com@evil.example/o/oauth2/v2/auth",
            "https://user:pass@accounts.google.com/o/oauth2/v2/auth",
            "https://user@accounts.google.com/o/oauth2/v2/auth",
            "https://evil-accounts.google.com/o/oauth2/v2/auth",
            "https://xaccounts.google.com/o/oauth2/v2/auth",
            "https://accounts.youtube.com/o/oauth2/v2/auth",
            "https://appleid.apple.com/auth/authorize",
            "https://claude.ai/login",
            "about:blank",
            "javascript:alert(1)",
            "data:text/html,hi",
            "file:///etc/passwd",
        ] {
            assert!(!opens(&url(denied), None), "{denied}");
        }
    }

    #[test]
    fn the_popup_stays_on_googles_sign_in_hosts() {
        for allowed in [
            AUTH,
            "https://accounts.google.com/v3/signin/identifier?x=1",
            "https://accounts.google.com/gsi/transform",
            "https://accounts.youtube.com/accounts/SetSID",
            "https://accounts.google.com.tr/accounts/SetSID",
            "https://accounts.google.co.uk/accounts/SetSID",
            "https://accounts.google.de/accounts/SetSID",
            "https://gds.google.com/web/recoveryoptions",
            "about:blank",
        ] {
            assert!(may_visit(&url(allowed), None), "{allowed}");
        }
        for denied in [
            "http://accounts.google.com/v3/signin",
            "https://accounts.google.com.evil.example/",
            "https://accounts.google.evil/",
            "https://accounts.google.com.evil/",
            "https://accounts.google.co.evil.example/",
            "https://accounts.google.c0m.tr/",
            "https://accounts.google./",
            "https://accounts.google.com@evil.example/",
            "https://a:b@accounts.google.com/",
            "https://accounts.google.com:444/",
            "https://www.google.com/search?q=x",
            "https://evil.example/",
            "https://claude.ai/",
            "https://youtube.com/",
            "file:///etc/passwd",
            "about:srcdoc",
        ] {
            assert!(!may_visit(&url(denied), None), "{denied}");
        }
    }

    #[test]
    fn a_stand_in_is_its_exact_origin() {
        let stand_in = url("http://localhost:4567");
        assert!(opens(&url("http://localhost:4567/start?x"), Some(&stand_in)));
        assert!(may_visit(&url("http://localhost:4567/popup"), Some(&stand_in)));
        assert!(!opens(&url("http://localhost:4568/start"), Some(&stand_in)));
        assert!(!opens(&url("http://127.0.0.1:4567/start"), Some(&stand_in)));
        assert!(!may_visit(&url("https://localhost:4567/"), Some(&stand_in)));
        assert!(opens(&url(AUTH), Some(&stand_in)));
    }
}
