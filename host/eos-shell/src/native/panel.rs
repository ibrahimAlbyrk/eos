//! The quick panel's window, which winit made a non-activating `NSPanel` (the vendored runtime's
//! `PANEL_CLASS`): it takes the keyboard without activating Eos, so the menu bar and the focus
//! come back to the app that had them. Here it is made to float over every app on every
//! space, placed and shown. Every function runs on the main thread.

use std::ffi::c_void;

use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize};

/// `NSWindowStyleMaskNonactivatingPanel`.
const NONACTIVATING: usize = 1 << 7;
/// `NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary`.
const ON_EVERY_SPACE: usize = (1 << 0) | (1 << 8);
/// `NSStatusWindowLevel`: above every app's windows, as Spotlight's panel.
const LEVEL: isize = 25;
/// The gap above the panel when the top third of the screen is too small to centre it in.
const MIN_TOP_GAP: f64 = 24.0;

/// Makes the panel `window` (an `NSWindow*` from `tauri::Window::ns_window`) float above
/// every app on every space and stay when Eos is not active.
pub(crate) fn float(window: *mut c_void) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    // SAFETY: main thread; `window` is a live NSPanel (the selectors below are NSPanel's).
    unsafe {
        let is_panel: Bool = msg_send![window, isKindOfClass: class!(NSPanel)];
        if !is_panel.as_bool() {
            return;
        }
        let _: () = msg_send![window, setFloatingPanel: Bool::YES];
        let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded: Bool::NO];
        let _: () = msg_send![window, setHidesOnDeactivate: Bool::NO];
        let _: () = msg_send![window, setLevel: LEVEL];
        let _: () = msg_send![window, setCollectionBehavior: ON_EVERY_SPACE];
    }
}

/// Where the panel goes: centred on the screen under the mouse, in that screen's top third.
fn frame_at_mouse(width: f64, height: f64) -> NSRect {
    // SAFETY: main thread; `NSEvent.mouseLocation` and `NSScreen` are read-only class calls,
    // and the screens array lives for the duration of this call.
    let (mouse, screens): (NSPoint, *mut AnyObject) =
        unsafe { (msg_send![class!(NSEvent), mouseLocation], msg_send![class!(NSScreen), screens]) };
    let mut visible = None;
    if !screens.is_null() {
        // SAFETY: an NSArray of NSScreen.
        let count: usize = unsafe { msg_send![screens, count] };
        for i in 0..count {
            // SAFETY: `i` is below `count`; `frame` and `visibleFrame` answer NSRect.
            let (frame, inside): (NSRect, NSRect) = unsafe {
                let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
                (msg_send![screen, frame], msg_send![screen, visibleFrame])
            };
            let hit = mouse.x >= frame.origin.x
                && mouse.x < frame.origin.x + frame.size.width
                && mouse.y >= frame.origin.y
                && mouse.y < frame.origin.y + frame.size.height;
            if hit || visible.is_none() {
                visible = Some(inside);
            }
            if hit {
                break;
            }
        }
    }
    let area = visible.unwrap_or(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1440.0, 900.0)));
    let top = area.origin.y + area.size.height - ((area.size.height / 3.0 - height) / 2.0).max(MIN_TOP_GAP);
    NSRect::new(NSPoint::new(area.origin.x + (area.size.width - width) / 2.0, top - height), NSSize::new(width, height))
}

/// Puts the panel at the mouse's screen with this size and brings it up without activating
/// Eos. `key`: it takes the keyboard (never in a quiet run, which must not take the user's).
pub(crate) fn show_at_mouse(window: *mut c_void, width: f64, height: f64, key: bool) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    let frame = frame_at_mouse(width, height);
    // SAFETY: main thread; `window` is a live NSWindow.
    unsafe {
        let _: () = msg_send![window, setFrame: frame, display: Bool::YES];
        let _: () = msg_send![window, orderFrontRegardless];
        if key {
            let _: () = msg_send![window, makeKeyWindow];
        }
    }
}

/// Gives the panel a new size, keeping its top edge where it is.
pub(crate) fn resize(window: *mut c_void, width: f64, height: f64) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    // SAFETY: main thread; `window` is a live NSWindow.
    unsafe {
        let old: NSRect = msg_send![window, frame];
        let top = old.origin.y + old.size.height;
        let x = old.origin.x + (old.size.width - width) / 2.0;
        let frame = NSRect::new(NSPoint::new(x, top - height), NSSize::new(width, height));
        let _: () = msg_send![window, setFrame: frame, display: Bool::YES];
    }
}

/// Takes the panel off screen. The app that had the focus keeps it: the panel never
/// activated Eos.
pub(crate) fn hide(window: *mut c_void) {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return;
    }
    // SAFETY: main thread; `window` is a live NSWindow.
    unsafe {
        let _: () = msg_send![window, orderOut: std::ptr::null_mut::<AnyObject>()];
    }
}

/// For the smoke run: whether the window is the panel class, non-activating, on screen and
/// key, and whether Eos is the active app.
pub(crate) fn report(window: *mut c_void) -> serde_json::Value {
    let window = window.cast::<AnyObject>();
    if window.is_null() {
        return serde_json::Value::Null;
    }
    // SAFETY: main thread; `window` is a live NSWindow; `NSApp` exists once the app runs.
    unsafe {
        let is_panel: Bool = msg_send![window, isKindOfClass: class!(NSPanel)];
        let mask: usize = msg_send![window, styleMask];
        let visible: Bool = msg_send![window, isVisible];
        let key: Bool = msg_send![window, isKeyWindow];
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let active: Bool = msg_send![app, isActive];
        serde_json::json!({
            "panel": is_panel.as_bool(),
            "nonactivating": mask & NONACTIVATING != 0,
            "visible": visible.as_bool(),
            "key": key.as_bool(),
            "appActive": active.as_bool(),
        })
    }
}
