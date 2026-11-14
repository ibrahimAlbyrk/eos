//! The one place a web view is created. Every view is created with `no_bridge`: no page in
//! Eos has `window.ipc`, `__TAURI_INTERNALS__` or any Tauri script, the dashboard included,
//! and neither has a popup a view opens. Pages reach Rust only through the in-process
//! handler of the app's own origin. A repo check (`cargo xtask shell`) fails when a view is
//! created anywhere else.

use std::path::Path;

use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{LogicalPosition, LogicalSize, Url, WebviewUrl};
use tauri_runtime_cef::WebviewBuilderCefExt;

use crate::log::log;

fn blank() -> WebviewUrl {
    // A constant that always parses.
    WebviewUrl::External(Url::parse("about:blank").unwrap_or_else(|_| unreachable!("about:blank is a URL")))
}

/// What a view may do beyond showing pages.
pub(crate) struct Policy {
    /// Decides main-frame navigations.
    pub(crate) navigation: Box<dyn Fn(&Url) -> bool + Send + Sync>,
    /// Told when a page asks for a new window that does not open.
    pub(crate) open_requested: Box<dyn Fn(&Url) + Send + Sync>,
    /// The popups that open, if any: none for every view but the claude.ai sign-in window.
    pub(crate) popups: Option<Popups>,
}

/// Popups a view lets open: a real window of their own, in the view's profile, with
/// `window.opener` (what an identity provider's popup needs to answer its page). One
/// closes with the view, opens no window of its own and has no bridge either.
pub(crate) struct Popups {
    /// Whether a popup to this address opens.
    pub(crate) open: Box<dyn Fn(&Url) -> bool + Send + Sync>,
    /// Decides the popup's main-frame navigations (the view's `navigation` does not apply).
    pub(crate) navigation: Box<dyn Fn(&Url) -> bool + Send + Sync>,
}

/// What kind of view a label names, for the log.
fn kind(label: &str) -> &'static str {
    match label {
        "main" => "dashboard",
        l if l.starts_with("signin-") => "sign-in window",
        l if l.starts_with("art-") => "artifact",
        l if l.starts_with("bt-") => "browser",
        l if l.starts_with("app-") => "plugin preview",
        l if l.starts_with("splash") => "splash",
        l if l.starts_with("host-") => "other computer's",
        _ => "unnamed",
    }
}

/// The host of a page, for the log: never its path or query (an OAuth address carries
/// state and codes).
pub(crate) fn host(url: &Url) -> String {
    url.host_str().map_or_else(|| format!("({})", url.scheme()), str::to_owned)
}

/// A builder for a view at `position` with `size`, starting on a blank page, with the
/// policy applied and every permission denied.
pub(crate) fn builder(
    label: &str,
    position: (f64, f64),
    size: (f64, f64),
    profile: Option<&Path>,
    policy: Policy,
) -> WebviewBuilder<tauri::DynRuntime> {
    let Policy { navigation, open_requested, popups } = policy;
    let kind = kind(label);
    let (opens, popup_navigation) = match popups {
        Some(Popups { open, navigation }) => (Some(open), Some(navigation)),
        None => (None, None),
    };
    let mut builder = WebviewBuilder::new(label, blank())
        .no_bridge(true)
        .position(LogicalPosition::new(position.0, position.1))
        .size(LogicalSize::new(size.0, size.1))
        .focused(false)
        .disable_drag_drop_handler()
        .on_navigation(move |url| navigation(url))
        .on_new_window(move |url, _features| {
            if opens.as_ref().is_some_and(|opens| opens(&url)) {
                log("views", &format!("a popup of the {kind} view opened on {}", host(&url)));
                return NewWindowResponse::Allow;
            }
            log("views", &format!("a popup of the {kind} view was not opened: {}", host(&url)));
            open_requested(&url);
            NewWindowResponse::Deny
        })
        .on_permission_request(|_webview, _kind| tauri::webview::PermissionResponse::Deny);
    if let Some(navigation) = popup_navigation {
        builder = builder.contain_popups(move |url| {
            let allowed = navigation(url);
            if !allowed {
                log("views", &format!("a popup of the {kind} view was kept from {}", host(url)));
            }
            allowed
        });
    }
    if let Some(profile) = profile {
        builder = builder.data_directory(profile.to_path_buf());
    }
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_names_the_view_and_only_the_host() {
        assert_eq!(kind("signin-claude-x-view"), "sign-in window");
        assert_eq!(kind("bt-0000abcd0001"), "browser");
        assert_eq!(kind("main"), "dashboard");
        let url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth?state=secret&code=c")
            .unwrap_or_else(|_| unreachable!());
        assert_eq!(host(&url), "accounts.google.com");
        assert_eq!(host(&Url::parse("about:blank").unwrap_or_else(|_| unreachable!())), "(about)");
    }
}
