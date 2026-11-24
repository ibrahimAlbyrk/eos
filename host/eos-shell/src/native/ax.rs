//! What the front app has selected, read through Accessibility for the quick panel (07 §4.3):
//! the focused element's selected text (never a secure field's), the focused window's
//! document and a web page's address. Each call waits at most 250 ms for the other app.
//! Asking for the permission and reading it are here too. Main thread.

use std::ffi::c_void;
use std::path::PathBuf;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::NSString;

type AxElement = *const c_void;
type CfType = *const c_void;

/// `kAXErrorSuccess`.
const OK: i32 = 0;
/// How long one call waits for the other app.
const TIMEOUT_S: f32 = 0.25;
/// How far up from the focused element a web page is looked for.
const MAX_ANCESTORS: usize = 12;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CfType) -> u8;
    fn AXUIElementCreateSystemWide() -> AxElement;
    fn AXUIElementSetMessagingTimeout(element: AxElement, seconds: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: AxElement, attribute: CfType, value: *mut CfType) -> i32;
    static kAXTrustedCheckOptionPrompt: CfType;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: CfType);
}

/// What was read; every part may be missing.
#[derive(Debug, Default)]
pub(crate) struct Selection {
    /// The front app's name.
    pub(crate) app: Option<String>,
    pub(crate) text: Option<String>,
    /// The file the focused window shows.
    pub(crate) document: Option<PathBuf>,
    /// The web page around the focused element.
    pub(crate) url: Option<String>,
}

/// Whether the user let Eos use Accessibility.
pub(crate) fn trusted() -> bool {
    // SAFETY: a plain query.
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Raises the system's own request for Accessibility (once a launch; macOS shows it only while
/// Eos is not yet in the list).
pub(crate) fn prompt() {
    // SAFETY: a dictionary of one boolean under the system's key; NSDictionary is toll-free
    // bridged to CFDictionary and lives until the call returns.
    unsafe {
        let yes: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithBool: Bool::YES];
        let key = kAXTrustedCheckOptionPrompt.cast::<AnyObject>();
        let options: Retained<AnyObject> = msg_send![class!(NSDictionary), dictionaryWithObject: &*yes, forKey: key];
        AXIsProcessTrustedWithOptions(Retained::as_ptr(&options).cast());
    }
}

/// Opens System Settings › Privacy & Security › Accessibility.
pub(crate) fn open_settings() {
    let _ = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

/// The front app's name, from AppKit (no permission needed).
fn front_app() -> Option<String> {
    // SAFETY: main thread; read-only NSWorkspace calls.
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let name: *mut NSString = msg_send![app, localizedName];
        (!name.is_null()).then(|| (*name).to_string())
    }
}

/// One attribute of an element, owned (released by the caller through [`Owned`]).
fn attribute(element: AxElement, name: &str) -> Option<Owned> {
    let name = NSString::from_str(name);
    let mut value: CfType = std::ptr::null();
    // SAFETY: `element` is a live AXUIElement; `name` is a CFString (toll-free bridged).
    let error = unsafe { AXUIElementCopyAttributeValue(element, Retained::as_ptr(&name).cast(), &mut value) };
    (error == OK && !value.is_null()).then_some(Owned(value))
}

/// A Core Foundation value this module copied, released when dropped.
struct Owned(CfType);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the value came from a Copy call and is released once.
        unsafe { CFRelease(self.0) }
    }
}

impl Owned {
    /// The value as text when it is a string.
    fn text(&self) -> Option<String> {
        let object = self.0.cast::<AnyObject>();
        // SAFETY: a CF value is an Objective-C object (toll-free bridging); checked before use.
        unsafe {
            let is_string: Bool = msg_send![object, isKindOfClass: class!(NSString)];
            is_string.as_bool().then(|| (*object.cast::<NSString>()).to_string())
        }
    }

    /// The value as a URL's text when it is a URL or a string.
    fn url(&self) -> Option<String> {
        let object = self.0.cast::<AnyObject>();
        // SAFETY: as above; `absoluteString` is an NSURL's.
        unsafe {
            let is_url: Bool = msg_send![object, isKindOfClass: class!(NSURL)];
            if is_url.as_bool() {
                let text: *mut NSString = msg_send![object, absoluteString];
                return (!text.is_null()).then(|| (*text).to_string());
            }
        }
        self.text()
    }
}

/// Reads what the front app has selected. Without the permission only the app's name.
pub(crate) fn selection() -> Selection {
    let mut found = Selection { app: front_app(), ..Selection::default() };
    if !trusted() {
        return found;
    }
    // SAFETY: the system-wide element is created and released here.
    let system = Owned(unsafe { AXUIElementCreateSystemWide() });
    // SAFETY: a live element; the timeout applies to every call through it and its children.
    unsafe { AXUIElementSetMessagingTimeout(system.0, TIMEOUT_S) };
    let Some(focused) = attribute(system.0, "AXFocusedUIElement") else { return found };
    let role = attribute(focused.0, "AXRole").and_then(|r| r.text());
    let subrole = attribute(focused.0, "AXSubrole").and_then(|r| r.text());
    let secure = [role.as_deref(), subrole.as_deref()].contains(&Some("AXSecureTextField"));
    if !secure {
        found.text = attribute(focused.0, "AXSelectedText").and_then(|t| t.text()).filter(|t| !t.trim().is_empty());
    }
    found.url = web_page(&focused);
    if let Some(app) = attribute(focused.0, "AXTopLevelUIElement").or_else(|| attribute(focused.0, "AXWindow")) {
        found.document = attribute(app.0, "AXDocument")
            .and_then(|d| d.url())
            .and_then(|url| url.strip_prefix("file://").map(|path| PathBuf::from(decode(path))));
    }
    found
}

/// The address of the web area around `element`: its own, or the nearest ancestor's.
fn web_page(element: &Owned) -> Option<String> {
    let mut current = attribute(element.0, "AXParent");
    if let Some(url) = attribute(element.0, "AXURL").and_then(|u| u.url()) {
        return web(url);
    }
    for _ in 0..MAX_ANCESTORS {
        let here = current?;
        if attribute(here.0, "AXRole").and_then(|r| r.text()).as_deref() == Some("AXWebArea") {
            return attribute(here.0, "AXURL").and_then(|u| u.url()).and_then(web);
        }
        current = attribute(here.0, "AXParent");
    }
    None
}

fn web(url: String) -> Option<String> {
    (url.starts_with("https://") || url.starts_with("http://")).then_some(url)
}

/// A file URL's path, its escapes decoded.
fn decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(hi), Some(lo)) =
                (bytes.get(i + 1).and_then(|b| hex(*b)), bytes.get(i + 2).and_then(|b| hex(*b)))
        {
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_documents_path_is_decoded_and_only_web_pages_are_kept() {
        assert_eq!(decode("/Users/me/My%20Notes/caf%C3%A9.txt"), "/Users/me/My Notes/café.txt");
        assert_eq!(decode("/a%2"), "/a%2");
        assert_eq!(web("https://example.com/a".into()).as_deref(), Some("https://example.com/a"));
        assert_eq!(web("file:///etc/passwd".into()), None);
    }
}
