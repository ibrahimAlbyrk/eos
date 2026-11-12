//! The native side of the bridges: the window, the clipboard, banners, dropped files.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

use eos_bridge::{Banner, BannerTarget, Bridge, EditCommand, ShellHost, Theme};
use serde_json::{Value, json};
use tauri_runtime_cef::WebviewCefExt;
use tauri_runtime_cef::cef::{ImplBrowser, ImplFrame};

use crate::log::log;
use crate::native::{appkit, notify};
use crate::views::Views;

/// The window's background before the first paint, by theme (the dashboard's own colors).
pub(crate) fn background(theme: Theme) -> tauri::window::Color {
    match theme {
        Theme::Dark => tauri::window::Color(0x1a, 0x1a, 0x1a, 0xff),
        Theme::Light => tauri::window::Color(0xf6, 0xf1, 0xe6, 0xff),
    }
}

pub(crate) struct Host {
    pub(crate) window: tauri::Window,
    pub(crate) views: Arc<Views>,
    pub(crate) rt: tokio::runtime::Handle,
    pub(crate) bridge: OnceLock<Weak<Bridge>>,
    /// A quiet run makes no sound.
    pub(crate) quiet: bool,
}

fn tag_of(target: Option<&BannerTarget>) -> String {
    match target {
        Some(BannerTarget::Worker(id)) => format!("worker:{id}"),
        Some(BannerTarget::Route(route)) => format!("route:{route}"),
        None => String::new(),
    }
}

/// The inverse of `tag_of`, for the identifier a clicked banner comes back with
/// (`<n>|<tag>`).
pub(crate) fn target_of(identifier: &str) -> Option<BannerTarget> {
    let tag = identifier.split_once('|').map_or(identifier, |(_, tag)| tag);
    if let Some(id) = tag.strip_prefix("worker:") {
        Some(BannerTarget::Worker(id.to_string()))
    } else {
        tag.strip_prefix("route:").map(|route| BannerTarget::Route(route.to_string()))
    }
}

/// Runs an editing command on the browser's focused frame.
pub(crate) fn frame_command(browser: &tauri_runtime_cef::cef::Browser, command: EditCommand) {
    let Some(frame) = browser.focused_frame().or_else(|| browser.main_frame()) else { return };
    match command {
        EditCommand::Undo => frame.undo(),
        EditCommand::Redo => frame.redo(),
        EditCommand::Cut => frame.cut(),
        EditCommand::Copy => frame.copy(),
        EditCommand::Paste => frame.paste(),
        EditCommand::SelectAll => frame.select_all(),
    }
}

impl Host {
    /// Real paths of the `File` objects the bridge script parked in the page after a drop.
    /// The page itself never sees a path; the DevTools protocol tells them to the shell.
    async fn dropped(&self) -> Vec<String> {
        let Some(dashboard) = self.views.dashboard() else { return Vec::new() };
        let cdp = &dashboard.cdp;
        let Ok(list) = cdp
            .call("Runtime.evaluate", json!({ "expression": "window.__eosDroppedFiles", "objectGroup": "eos-drop" }))
            .await
        else {
            return Vec::new();
        };
        let Some(object) = list.pointer("/result/objectId").and_then(Value::as_str) else { return Vec::new() };
        let properties = cdp
            .call("Runtime.getProperties", json!({ "objectId": object, "ownProperties": true }))
            .await
            .unwrap_or(Value::Null);
        let mut indexed: Vec<(usize, String)> = properties
            .get("result")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some((p.get("name")?.as_str()?.parse().ok()?, p.pointer("/value/objectId")?.as_str()?.to_string()))
            })
            .collect();
        indexed.sort();
        let mut paths = Vec::new();
        for (_, file) in indexed {
            if let Ok(info) = cdp.call("DOM.getFileInfo", json!({ "objectId": file })).await
                && let Some(path) = info.get("path").and_then(Value::as_str).filter(|p| !p.is_empty())
            {
                paths.push(path.to_string());
            }
        }
        let _ = cdp.call("Runtime.releaseObjectGroup", json!({ "objectGroup": "eos-drop" })).await;
        paths
    }
}

impl ShellHost for Host {
    fn start_window_drag(&self) {
        let _ = self.window.start_dragging();
    }

    fn toggle_window_zoom(&self) {
        let zoomed = self.window.is_maximized().unwrap_or(false);
        let _ = if zoomed { self.window.unmaximize() } else { self.window.maximize() };
    }

    fn window_focused(&self) -> bool {
        self.window.is_focused().unwrap_or(false) && self.window.is_visible().unwrap_or(false)
    }

    fn set_theme(&self, theme: Theme) {
        let _ = self.window.set_background_color(Some(background(theme)));
    }

    fn show_banner(&self, banner: Banner) {
        if !notify::show(&banner.title, &banner.body, &tag_of(banner.target.as_ref()), self.quiet) {
            log("notify", "no banner: the app is not running from a bundle");
        }
    }

    fn clipboard_text(&self) -> Option<String> {
        appkit::clipboard_text()
    }

    fn set_clipboard_text(&self, text: &str) {
        appkit::set_clipboard_text(text);
    }

    fn clipboard_file_paths(&self) -> Vec<String> {
        appkit::clipboard_file_paths()
    }

    fn clipboard_has_files(&self) -> bool {
        appkit::clipboard_has_files()
    }

    fn dropped_file_paths(&self) -> Vec<String> {
        // Called on a blocking thread, so waiting on the runtime here is allowed.
        self.rt.block_on(self.dropped())
    }

    fn edit(&self, command: EditCommand) {
        let Some(dashboard) = self.views.dashboard() else { return };
        let _ = dashboard.webview.with_cef_webview(move |w| frame_command(&w.browser(), command));
    }

    fn open_path(&self, path: &Path) {
        open_with_system(&path.to_string_lossy());
    }

    fn downloads_dir(&self) -> PathBuf {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Downloads")
    }
}

/// Hands a file path or a web link to the system (`open`). Never a string that could be
/// read as an option.
pub(crate) fn open_with_system(target: &str) {
    if target.is_empty() || target.starts_with('-') {
        return;
    }
    let _ = std::process::Command::new("/usr/bin/open").arg(target).stdin(std::process::Stdio::null()).spawn();
}

/// A link a page wants opened outside the app: web and mail links only.
pub(crate) fn open_external(url: &tauri::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        open_with_system(url.as_str());
    }
}

/// The system opener for the core: a page it wants the user to see in their own browser (a
/// sign-in page). The same rule as for a link a page opens: web and mail links only.
pub(crate) struct Opener;

impl eos_core::accounts::Browser for Opener {
    fn open(&self, url: &str) {
        match tauri::Url::parse(url) {
            Ok(url) => open_external(&url),
            Err(_) => log("shell", "not a link: nothing was opened"),
        }
    }
}
