//! The one place a web view is created. Every view is created with `no_bridge`: no page in
//! Eos has `window.ipc`, `__TAURI_INTERNALS__` or any Tauri script, the dashboard included.
//! Pages reach Rust only through the in-process handler of the app's own origin. A repo
//! check (`cargo xtask shell`) fails when a view is created anywhere else.

use std::path::Path;

use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{LogicalPosition, LogicalSize, Url, WebviewUrl};
use tauri_runtime_cef::WebviewBuilderCefExt;

fn blank() -> WebviewUrl {
    // A constant that always parses.
    WebviewUrl::External(Url::parse("about:blank").unwrap_or_else(|_| unreachable!("about:blank is a URL")))
}

/// What a view may do beyond showing pages.
pub(crate) struct Policy {
    /// Decides main-frame navigations.
    pub(crate) navigation: Box<dyn Fn(&Url) -> bool + Send + Sync>,
    /// Told when a page asks for a new window; nothing is ever opened.
    pub(crate) open_requested: Box<dyn Fn(&Url) + Send + Sync>,
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
    let Policy { navigation, open_requested } = policy;
    let mut builder = WebviewBuilder::new(label, blank())
        .no_bridge(true)
        .position(LogicalPosition::new(position.0, position.1))
        .size(LogicalSize::new(size.0, size.1))
        .focused(false)
        .disable_drag_drop_handler()
        .on_navigation(move |url| navigation(url))
        .on_new_window(move |url, _features| {
            open_requested(&url);
            NewWindowResponse::Deny
        })
        .on_permission_request(|_webview, _kind| tauri::webview::PermissionResponse::Deny);
    if let Some(profile) = profile {
        builder = builder.data_directory(profile.to_path_buf());
    }
    builder
}
