//! The number on the app's Dock icon (`NSApp.dockTile.badgeLabel`).

use eos_core::os::DockBadge;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use tauri::Manager as _;

/// Shows `label` on the Dock icon, or none. Main thread.
fn set_label(label: Option<&str>) {
    let text = label.map(NSString::from_str);
    let text: *const NSString = text.as_deref().map_or(std::ptr::null(), |t| t as *const NSString);
    // SAFETY: main thread; `NSApp` and its dock tile live for the process, and `setBadgeLabel:`
    // copies the string (nil clears it).
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let tile: *mut AnyObject = msg_send![app, dockTile];
        if !tile.is_null() {
            let _: () = msg_send![tile, setBadgeLabel: text];
        }
    }
}

/// The label on the Dock icon, if any. Main thread.
pub(crate) fn label() -> Option<String> {
    // SAFETY: as in `set_label`; `badgeLabel` is an NSString or nil, retained for the read.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let tile: *mut AnyObject = msg_send![app, dockTile];
        if tile.is_null() {
            return None;
        }
        let label: Option<Retained<NSString>> = msg_send![tile, badgeLabel];
        label.map(|l| l.to_string())
    }
}

/// The shell's [`DockBadge`]: the core sets it from its own threads, AppKit wants the main one.
pub(crate) struct DockTile(pub(crate) tauri::AppHandle);

impl DockBadge for DockTile {
    fn set(&self, count: Option<u32>) {
        let label = count.map(|n| n.to_string());
        let _ = self.0.run_on_main_thread(move || set_label(label.as_deref()));
    }
}
