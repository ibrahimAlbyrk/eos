//! The app as a login item, through `SMAppService.mainAppService` (macOS 13 and later). On
//! macOS 12 the class does not exist and the login item is unavailable. Any thread.

use eos_bridge::LoginItem;
use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyClass, AnyObject};

use crate::log::log;

#[link(name = "ServiceManagement", kind = "framework")]
unsafe extern "C" {}

/// `SMAppServiceStatus` (0 is "not registered", 3 "not found").
const ENABLED: isize = 1;
const REQUIRES_APPROVAL: isize = 2;

fn service_class() -> Option<&'static AnyClass> {
    AnyClass::get(c"SMAppService")
}

/// The main app's service, or none before macOS 13.
fn main_app() -> Option<*mut AnyObject> {
    let class = service_class()?;
    // SAFETY: `mainAppService` is a class method of SMAppService returning an autoreleased
    // object that lives at least as long as the current autorelease pool.
    let service: *mut AnyObject = unsafe { msg_send![class, mainAppService] };
    (!service.is_null()).then_some(service)
}

/// What a status code means for the dashboard. "Not found" (the system has no record of the
/// app) is off, as is "not registered".
fn state_of(status: isize) -> LoginItem {
    match status {
        ENABLED => LoginItem::On,
        REQUIRES_APPROVAL => LoginItem::NeedsApproval,
        _ => LoginItem::Off,
    }
}

/// The login item's state, read from the system.
pub(crate) fn status() -> LoginItem {
    // The calls answer autoreleased objects, and a blocking thread has no pool of its own.
    autoreleasepool(|_| read())
}

fn read() -> LoginItem {
    let Some(service) = main_app() else { return LoginItem::Unavailable };
    // SAFETY: `service` is a live SMAppService; `status` returns an NSInteger.
    let status: isize = unsafe { msg_send![service, status] };
    state_of(status)
}

/// Registers or unregisters the app; answers the state after. A failure is logged by its
/// error code only.
pub(crate) fn set(on: bool) -> LoginItem {
    autoreleasepool(|_| change(on))
}

fn change(on: bool) -> LoginItem {
    let Some(service) = main_app() else { return LoginItem::Unavailable };
    let before = read();
    if (on && before != LoginItem::Off) || (!on && before == LoginItem::Off) {
        return before;
    }
    let mut error: *mut AnyObject = std::ptr::null_mut();
    // SAFETY: `service` is a live SMAppService; both methods take an `NSError **` out
    // parameter, set (autoreleased) only on failure.
    let done: bool = unsafe {
        if on {
            msg_send![service, registerAndReturnError: &mut error]
        } else {
            msg_send![service, unregisterAndReturnError: &mut error]
        }
    };
    if !done {
        // SAFETY: on failure `error` is an NSError or nil; `code` returns an NSInteger.
        let code: isize = if error.is_null() { 0 } else { unsafe { msg_send![error, code] } };
        let verb = if on { "registered" } else { "unregistered" };
        log("login", &format!("the login item was not {verb} (error {code})"));
    }
    read()
}

/// Opens System Settings › General › Login Items.
pub(crate) fn open_settings() {
    let Some(class) = service_class() else { return };
    // SAFETY: a class method with no arguments and no result.
    unsafe {
        let _: () = msg_send![class, openSystemSettingsLoginItems];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_status_names_the_state() {
        assert_eq!(state_of(0), LoginItem::Off, "not registered");
        assert_eq!(state_of(ENABLED), LoginItem::On);
        assert_eq!(state_of(REQUIRES_APPROVAL), LoginItem::NeedsApproval);
        assert_eq!(state_of(3), LoginItem::Off, "not found");
    }
}
