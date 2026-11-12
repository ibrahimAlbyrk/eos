//! AppKit calls Tauri has no API for. Every function here must run on the main thread
//! unless it says otherwise; the callers get there through Tauri's main-thread dispatch.

use std::ffi::c_void;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{class, msg_send, sel};
use objc2_foundation::NSString;

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn strings(array: Option<Retained<AnyObject>>) -> Vec<String> {
    let Some(array) = array else { return Vec::new() };
    // SAFETY: `array` is an NSArray; `count` and `objectAtIndex:` are its basic accessors.
    unsafe {
        let is_array: Bool = msg_send![&*array, isKindOfClass: class!(NSArray)];
        if !is_array.as_bool() {
            return Vec::new();
        }
        let count: usize = msg_send![&*array, count];
        (0..count)
            .filter_map(|i| {
                let item: *mut AnyObject = msg_send![&*array, objectAtIndex: i];
                let is_string: Bool = msg_send![item, isKindOfClass: class!(NSString)];
                is_string.as_bool().then(|| (*(item as *const NSString)).to_string())
            })
            .collect()
    }
}

// ---- views ---------------------------------------------------------------------

/// Puts a child view above its siblings without reloading it: re-adding a subview moves it.
/// `view` is a CEF browser's `NSView`.
pub(crate) fn bring_view_to_front(view: *mut c_void) {
    let view = view.cast::<AnyObject>();
    if view.is_null() {
        return;
    }
    // SAFETY: main thread; `view` is a live NSView owned by the window.
    unsafe {
        let superview: *mut AnyObject = msg_send![view, superview];
        if superview.is_null() {
            return;
        }
        // NSWindowAbove = 1
        let _: () =
            msg_send![superview, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Rounds the corners of a child view (the artifact peek and tab), clipping its content.
/// `view` is a CEF browser's `NSView`.
pub(crate) fn set_corner_radius(view: *mut c_void, radius: f64) {
    let view = view.cast::<AnyObject>();
    if view.is_null() {
        return;
    }
    // SAFETY: main thread; `view` is a live NSView owned by the window, and a layer-backed
    // view's `layer` is a CALayer for as long as the view lives.
    unsafe {
        let _: () = msg_send![view, setWantsLayer: Bool::YES];
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: Bool::new(radius > 0.0)];
    }
}

/// Whether the window's first responder is `view` or inside it: that view has the keyboard.
pub(crate) fn view_has_focus(view: *mut c_void) -> bool {
    let view = view.cast::<AnyObject>();
    if view.is_null() {
        return false;
    }
    // SAFETY: main thread; `view` is a live NSView.
    unsafe {
        let window: *mut AnyObject = msg_send![view, window];
        if window.is_null() {
            return false;
        }
        let responder: *mut AnyObject = msg_send![window, firstResponder];
        if responder.is_null() {
            return false;
        }
        let is_view: Bool = msg_send![responder, isKindOfClass: class!(NSView)];
        if !is_view.as_bool() {
            return false;
        }
        let inside: Bool = msg_send![responder, isDescendantOf: view];
        inside.as_bool()
    }
}

/// Sends a standard editing action (`copy:`, `paste:`, …) down the responder chain, for a
/// focus that is in no web view (a text field of a system panel).
pub(crate) fn send_edit_action(command: eos_bridge::EditCommand) {
    use eos_bridge::EditCommand as E;
    let selector = match command {
        E::Undo => sel!(undo:),
        E::Redo => sel!(redo:),
        E::Cut => sel!(cut:),
        E::Copy => sel!(copy:),
        E::Paste => sel!(paste:),
        E::SelectAll => sel!(selectAll:),
    };
    // SAFETY: main thread; a nil target sends the action to the first responder that takes it.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: Bool = msg_send![app, sendAction: selector, to: std::ptr::null_mut::<AnyObject>(), from: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Brings the app to the front (a click on a banner, a second launch).
pub(crate) fn activate_app() {
    // SAFETY: main thread.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
    }
}

// ---- pasteboard (any thread: NSPasteboard is documented as thread-safe) -----------

fn pasteboard() -> Option<Retained<AnyObject>> {
    // SAFETY: a class method with no arguments.
    unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
}

const TEXT: &str = "public.utf8-plain-text";

pub(crate) fn clipboard_text() -> Option<String> {
    let pb = pasteboard()?;
    // SAFETY: `stringForType:` returns an NSString or nil.
    let text: Option<Retained<NSString>> = unsafe { msg_send![&*pb, stringForType: &*ns(TEXT)] };
    text.map(|t| t.to_string())
}

pub(crate) fn set_clipboard_text(text: &str) {
    let Some(pb) = pasteboard() else { return };
    // SAFETY: both are plain NSPasteboard calls with NSString arguments.
    unsafe {
        let _: isize = msg_send![&*pb, clearContents];
        let _: Bool = msg_send![&*pb, setString: &*ns(text), forType: &*ns(TEXT)];
    }
}

fn clipboard_types() -> Vec<String> {
    let Some(pb) = pasteboard() else { return Vec::new() };
    // SAFETY: `types` returns an NSArray of NSString or nil.
    strings(unsafe { msg_send![&*pb, types] })
}

/// Whether the clipboard holds an image or files rather than text.
pub(crate) fn clipboard_has_files() -> bool {
    clipboard_types().iter().any(|t| {
        matches!(t.as_str(), "public.file-url" | "NSFilenamesPboardType" | "public.png" | "public.tiff" | "public.jpeg")
    })
}

/// Paths of the items copied in the Finder. Its ⌘C lists every item's real path under the
/// old filenames type; the file URL is the fallback (a reference URL, `/.file/id=…`, is not
/// a path).
pub(crate) fn clipboard_file_paths() -> Vec<String> {
    let Some(pb) = pasteboard() else { return Vec::new() };
    // SAFETY: `propertyListForType:` returns a property list object or nil.
    let names = strings(unsafe { msg_send![&*pb, propertyListForType: &*ns("NSFilenamesPboardType")] });
    if !names.is_empty() {
        return names;
    }
    // SAFETY: as in `clipboard_text`.
    let url: Option<Retained<NSString>> = unsafe { msg_send![&*pb, stringForType: &*ns("public.file-url")] };
    url.map(|u| u.to_string())
        .and_then(|u| u.strip_prefix("file://").map(eos_bridge::urlspace::percent_decode))
        .filter(|path| path.starts_with('/') && !path.starts_with("/.file/"))
        .into_iter()
        .collect()
}

// ---- open panel ------------------------------------------------------------------

/// Runs the system's open panel modally and returns the chosen paths; `None` when the user
/// cancelled. Blocks the main thread in the panel's own event loop.
pub(crate) fn open_panel(directories: bool, multiple: bool) -> Option<Vec<String>> {
    open_panel_for(directories, !directories, multiple)
}

/// The open panel offering files and folders alike, several at once (what to send to
/// another computer).
pub(crate) fn open_panel_any() -> Option<Vec<String>> {
    open_panel_for(true, true, true)
}

fn open_panel_for(directories: bool, files: bool, multiple: bool) -> Option<Vec<String>> {
    // SAFETY: main thread; plain NSOpenPanel setters and getters.
    unsafe {
        let panel: Option<Retained<AnyObject>> = msg_send![class!(NSOpenPanel), openPanel];
        let panel = panel?;
        let _: () = msg_send![&*panel, setCanChooseDirectories: Bool::new(directories)];
        let _: () = msg_send![&*panel, setCanChooseFiles: Bool::new(files)];
        let _: () = msg_send![&*panel, setCanCreateDirectories: Bool::new(directories)];
        let _: () = msg_send![&*panel, setAllowsMultipleSelection: Bool::new(multiple)];
        // NSModalResponseOK = 1
        let response: isize = msg_send![&*panel, runModal];
        if response != 1 {
            return None;
        }
        let urls: Option<Retained<AnyObject>> = msg_send![&*panel, URLs];
        let urls = urls?;
        let count: usize = msg_send![&*urls, count];
        let paths = (0..count)
            .filter_map(|i| {
                let url: *mut AnyObject = msg_send![&*urls, objectAtIndex: i];
                let path: Option<Retained<NSString>> = msg_send![url, path];
                path.map(|p| p.to_string())
            })
            .collect();
        Some(paths)
    }
}

// ---- the bundle ------------------------------------------------------------------

/// The running app's bundle identifier; `None` for a bare executable outside a bundle.
/// Any thread.
pub(crate) fn bundle_identifier() -> Option<String> {
    // SAFETY: plain NSBundle getters.
    unsafe {
        let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
        if bundle.is_null() {
            return None;
        }
        let id: Option<Retained<NSString>> = msg_send![bundle, bundleIdentifier];
        id.map(|s| s.to_string())
    }
}

/// Whether a class exists in this process (a framework is loaded).
pub(crate) fn has_class(name: &std::ffi::CStr) -> bool {
    AnyClass::get(name).is_some()
}
