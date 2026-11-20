//! The Apple Event that launched the app. AppKit hands it to the app while it finishes
//! launching, which is when the shell's setup runs; afterwards there is no current event.

use eos_bridge::launch::LaunchEvent;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};

const fn code(four: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*four)
}

const CORE_SUITE: u32 = code(b"aevt");
const OPEN_APPLICATION: u32 = code(b"oapp");
const OPEN_DOCUMENTS: u32 = code(b"odoc");
const INTERNET_SUITE: u32 = code(b"GURL");
const GET_URL: u32 = code(b"GURL");
/// `keyAEPropData`: where the system marks an open as a login item's.
const PROP_DATA: u32 = code(b"prdt");
/// `keyAELaunchedAsLogInItem`.
const LAUNCHED_AS_LOGIN_ITEM: u32 = code(b"lgit");

/// An Apple Event's class, id and login marker.
pub(crate) type Codes = (u32, u32, Option<u32>);

/// What an event's codes mean for the launch; `None` for any other event.
pub(crate) fn event_of(class: u32, id: u32, marker: Option<u32>) -> Option<LaunchEvent> {
    match (class, id) {
        (CORE_SUITE, OPEN_APPLICATION) => {
            Some(LaunchEvent::OpenApplication { as_login_item: marker == Some(LAUNCHED_AS_LOGIN_ITEM) })
        }
        (CORE_SUITE, OPEN_DOCUMENTS) => Some(LaunchEvent::OpenDocuments),
        (INTERNET_SUITE, GET_URL) => Some(LaunchEvent::OpenUrl),
        _ => None,
    }
}

/// The event's codes, for the log: they say nothing about the user.
pub(crate) fn describe(event: Option<Codes>) -> String {
    let Some((class, id, marker)) = event else { return "none".to_owned() };
    format!("{}/{} (marker {})", name(class), name(id), marker.map_or_else(|| "none".to_owned(), name))
}

fn name(code: u32) -> String {
    code.to_be_bytes().iter().map(|&b| if b.is_ascii_graphic() { b as char } else { '?' }).collect()
}

/// The event AppKit is handling: class, id and the login marker's code. `None` when there
/// is none. Main thread.
pub(crate) fn current() -> Option<Codes> {
    // SAFETY: main thread; `sharedAppleEventManager` lives for the process, and
    // `currentAppleEvent` is an NSAppleEventDescriptor (or nil) owned by AppKit for the
    // length of this call.
    unsafe {
        let manager: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        if manager.is_null() {
            return None;
        }
        let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
        if event.is_null() {
            return None;
        }
        let class: u32 = msg_send![event, eventClass];
        let id: u32 = msg_send![event, eventID];
        let property: *mut AnyObject = msg_send![event, paramDescriptorForKeyword: PROP_DATA];
        let marker: Option<u32> = (!property.is_null()).then(|| msg_send![property, enumCodeValue]);
        Some((class, id, marker))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_events_codes_name_the_launch() {
        let open = |marker| event_of(code(b"aevt"), code(b"oapp"), marker);
        assert_eq!(open(None), Some(LaunchEvent::OpenApplication { as_login_item: false }));
        assert_eq!(open(Some(code(b"lgit"))), Some(LaunchEvent::OpenApplication { as_login_item: true }));
        assert_eq!(open(Some(code(b"xxxx"))), Some(LaunchEvent::OpenApplication { as_login_item: false }));
        assert_eq!(event_of(code(b"aevt"), code(b"odoc"), None), Some(LaunchEvent::OpenDocuments));
        assert_eq!(event_of(code(b"GURL"), code(b"GURL"), None), Some(LaunchEvent::OpenUrl));
        assert_eq!(event_of(code(b"aevt"), code(b"rapp"), None), None);
        assert_eq!(describe(Some((code(b"aevt"), code(b"oapp"), None))), "aevt/oapp (marker none)");
        assert_eq!(describe(None), "none");
    }
}
