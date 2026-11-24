//! The capability secret prompt (06 G4): an app-modal `NSAlert` with an `NSSecureTextField`
//! as its accessory, as macOS's own password prompts are. What the user types is read once
//! from the field into a string that is wiped when dropped, and the field is cleared.
//! AppKit's own copy of the field's text is not ours to wipe.

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use zeroize::Zeroizing;

/// `NSAlertFirstButtonReturn`: the first button added, "Save".
const SAVE: isize = 1000;

/// Asks for a secret: `title` names what it is for, `detail` where to find it. `None`
/// when the user cancelled. Must run on the main thread; blocks it in the alert's own event
/// loop until the user answers.
pub(crate) fn ask(title: &str, detail: &str) -> Option<Zeroizing<String>> {
    // SAFETY: main thread; plain NSApplication, NSAlert and NSSecureTextField calls, each
    // object retained for as long as it is used.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
        let alert: Option<Retained<AnyObject>> = msg_send![class!(NSAlert), new];
        let alert = alert?;
        let _: () = msg_send![&*alert, setMessageText: &*NSString::from_str(title)];
        let _: () = msg_send![&*alert, setInformativeText: &*NSString::from_str(detail)];
        let _: *mut AnyObject = msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Save")];
        let _: *mut AnyObject = msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("Cancel")];
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 24.0));
        let field: Allocated<AnyObject> = msg_send![class!(NSSecureTextField), alloc];
        let field: Option<Retained<AnyObject>> = msg_send![field, initWithFrame: frame];
        let field = field?;
        let _: () = msg_send![&*alert, setAccessoryView: &*field];
        let window: *mut AnyObject = msg_send![&*alert, window];
        let _: () = msg_send![window, setInitialFirstResponder: &*field];
        let answer: isize = msg_send![&*alert, runModal];
        let typed: Option<Retained<NSString>> = msg_send![&*field, stringValue];
        let value = Zeroizing::new(typed.map(|text| text.to_string()).unwrap_or_default());
        let _: () = msg_send![&*field, setStringValue: &*NSString::from_str("")];
        (answer == SAVE).then_some(value)
    }
}
