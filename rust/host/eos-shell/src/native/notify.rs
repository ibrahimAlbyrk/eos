//! Native banners through `UNUserNotificationCenter`: the app's own sound, and a click that
//! comes back with the banner's tag.
//!
//! The center only exists for a bundled app (it is keyed by the bundle identifier and asking
//! for it from a bare executable raises), so a development run outside a bundle shows
//! nothing and says so in the log.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject};
use objc2::{ClassType, class, define_class, msg_send};
use objc2_foundation::NSString;

use super::appkit;

/// The sound file in the bundle's resources.
const SOUND: &str = "eos-notification.aiff";

type Clicked = Box<dyn Fn(String) + Send + Sync>;
static CLICKED: OnceLock<Clicked> = OnceLock::new();
static DELEGATE: OnceLock<DelegateRef> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);

/// The delegate lives for the whole process; the center keeps only a weak reference.
struct DelegateRef(Retained<Delegate>);
// SAFETY: the object is immutable and only handed to the notification center.
unsafe impl Send for DelegateRef {}
unsafe impl Sync for DelegateRef {}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the class adds no state.
    #[unsafe(super(NSObject))]
    #[name = "EosNotificationDelegate"]
    struct Delegate;

    impl Delegate {
        /// A banner was clicked: hand its tag back, then tell the system we are done.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &AnyObject, response: &AnyObject, done: &DynBlock<dyn Fn()>) {
            // SAFETY: response → notification → request → identifier are plain getters.
            let identifier: Option<Retained<NSString>> = unsafe {
                let notification: *mut AnyObject = msg_send![response, notification];
                let request: *mut AnyObject = msg_send![notification, request];
                msg_send![request, identifier]
            };
            if let (Some(identifier), Some(clicked)) = (identifier, CLICKED.get()) {
                clicked(identifier.to_string());
            }
            done.call(());
        }

        /// Asked while the app is frontmost: still show it (the shell only posts a banner
        /// when its window is not focused).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &AnyObject, _notification: &AnyObject, done: &DynBlock<dyn Fn(usize)>) {
            // UNNotificationPresentationOptionSound | List | Banner
            done.call(((1 << 1) | (1 << 3) | (1 << 4),));
        }
    }
);

fn center() -> Option<Retained<AnyObject>> {
    if appkit::bundle_identifier().is_none() || !appkit::has_class(c"UNUserNotificationCenter") {
        return None;
    }
    // SAFETY: a class method; valid because the process has a bundle identifier.
    unsafe { msg_send![class!(UNUserNotificationCenter), currentNotificationCenter] }
}

/// Registers what a click on a banner calls, with the tag given to [`show`]. Once.
pub(crate) fn on_click(clicked: impl Fn(String) + Send + Sync + 'static) {
    let _ = CLICKED.set(Box::new(clicked));
}

fn ensure_delegate(center: &AnyObject) {
    let delegate = DELEGATE.get_or_init(|| {
        // SAFETY: `new` on an NSObject subclass without ivars.
        DelegateRef(unsafe { msg_send![Delegate::class(), new] })
    });
    // Chromium's own notification service may have taken the delegate slot; take it back
    // before every banner so the click reaches us.
    // SAFETY: `setDelegate:` with a live object the static keeps alive.
    unsafe {
        let _: () = msg_send![center, setDelegate: &*delegate.0];
    }
}

/// Shows a banner, with the app's sound unless `silent`. `tag` comes back through the click
/// callback. Returns false when the process has no notification center (not bundled). Any
/// thread.
pub(crate) fn show(title: &str, body: &str, tag: &str, silent: bool) -> bool {
    let Some(center) = center() else { return false };
    ensure_delegate(&center);
    let (title, body) = (title.to_string(), body.to_string());
    // Unique per banner: a repeated identifier would replace the earlier banner.
    let identifier = format!("{}|{tag}", NEXT.fetch_add(1, Ordering::SeqCst));
    let center_for_post = center.clone();
    let post = move || {
        // SAFETY: plain setters on a fresh content object, then one request to the center.
        unsafe {
            let content: Retained<AnyObject> = msg_send![class!(UNMutableNotificationContent), new];
            let _: () = msg_send![&*content, setTitle: &*NSString::from_str(&title)];
            let _: () = msg_send![&*content, setBody: &*NSString::from_str(&body)];
            if !silent {
                let sound: Option<Retained<AnyObject>> =
                    msg_send![class!(UNNotificationSound), soundNamed: &*NSString::from_str(SOUND)];
                if let Some(sound) = sound {
                    let _: () = msg_send![&*content, setSound: &*sound];
                }
            }
            let request: Option<Retained<AnyObject>> = msg_send![
                class!(UNNotificationRequest),
                requestWithIdentifier: &*NSString::from_str(&identifier),
                content: &*content,
                trigger: std::ptr::null_mut::<AnyObject>()
            ];
            if let Some(request) = request {
                let none: *const DynBlock<dyn Fn(*mut AnyObject)> = std::ptr::null();
                let _: () =
                    msg_send![&*center_for_post, addNotificationRequest: &*request, withCompletionHandler: none];
            }
        }
    };
    // The system asks the user once; later calls answer at once with the stored choice.
    let granted = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
        if granted.as_bool() {
            post();
            crate::log::log("notify", "banner posted");
        } else {
            crate::log::log("notify", "no banner: notifications are not allowed for the app in System Settings");
        }
    });
    // UNAuthorizationOptionSound | Alert
    let options: usize = (1 << 1) | (1 << 2);
    // SAFETY: the block is copied by the center and called once on a system queue.
    unsafe {
        let _: () = msg_send![&*center, requestAuthorizationWithOptions: options, completionHandler: &*granted];
    }
    true
}

/// Takes the app's banners out of Notification Center. Any thread.
pub(crate) fn clear_delivered() {
    if let Some(center) = center() {
        // SAFETY: a plain call without arguments.
        unsafe {
            let _: () = msg_send![&*center, removeAllDeliveredNotifications];
        }
    }
}
