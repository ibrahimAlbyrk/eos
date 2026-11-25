//! "Send to Eos" in the Services menu (07 §4.3): Info.plist's `NSServices` names the message
//! `sendToEos`, and an object of this module's class, set as `NSApp.servicesProvider`, answers
//! it by reading the pasteboard the other app filled: file URLs, a web address, text. Main
//! thread.

use std::path::PathBuf;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{class, msg_send, sel};
use objc2_foundation::NSString;

/// What the pasteboard held, in the order the panel shows it.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Sent {
    pub(crate) files: Vec<PathBuf>,
    pub(crate) url: Option<String>,
    pub(crate) text: Option<String>,
}

type Received = Box<dyn Fn(Sent) + Send + Sync>;

static RECEIVED: OnceLock<Received> = OnceLock::new();

/// `- (void)sendToEos:(NSPasteboard *)pboard userData:(NSString *)data error:(NSString **)error`.
extern "C-unwind" fn send_to_eos(
    _this: &AnyObject,
    _cmd: Sel,
    pasteboard: *mut AnyObject,
    _data: *mut AnyObject,
    _error: *mut *mut AnyObject,
) {
    if pasteboard.is_null() {
        return;
    }
    let sent = read(pasteboard);
    if let Some(received) = RECEIVED.get() {
        // A panic must not unwind into AppKit's service dispatch.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| received(sent)));
    }
}

fn provider_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let Some(mut builder) = ClassBuilder::new(c"EosServicesProvider", class!(NSObject)) else {
            return AnyClass::get(c"EosServicesProvider").unwrap_or_else(|| class!(NSObject));
        };
        // SAFETY: the function's types are the service message's: an object, a selector, the
        // pasteboard, the user data and the error out-pointer, answering nothing.
        unsafe {
            builder.add_method(sel!(sendToEos:userData:error:), send_to_eos as extern "C-unwind" fn(_, _, _, _, _));
        }
        builder.register()
    })
}

/// Makes Eos the provider of its Services entry; `received` gets what each request carried.
/// Once a launch.
pub(crate) fn provide(received: impl Fn(Sent) + Send + Sync + 'static) {
    if RECEIVED.set(Box::new(received)).is_err() {
        return;
    }
    // SAFETY: main thread; a fresh instance of the provider class, kept by `NSApp` (and leaked
    // here on purpose: it serves for the whole launch).
    unsafe {
        let provider: *mut AnyObject = msg_send![provider_class(), new];
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setServicesProvider: provider];
    }
}

/// Reads a pasteboard: file URLs first, then a web address, then plain text.
fn read(pasteboard: *mut AnyObject) -> Sent {
    let mut sent = Sent::default();
    // SAFETY: `pasteboard` is a live NSPasteboard; the arrays and strings it answers are
    // autoreleased and read before this returns.
    unsafe {
        let url_class: &AnyClass = class!(NSURL);
        let classes: Retained<AnyObject> = msg_send![class!(NSArray), arrayWithObject: url_class];
        let key = NSString::from_str("NSPasteboardURLReadingFileURLsOnlyKey");
        let yes: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithBool: Bool::YES];
        let options: Retained<AnyObject> = msg_send![class!(NSDictionary), dictionaryWithObject: &*yes, forKey: &*key];
        let urls: *mut AnyObject = msg_send![pasteboard, readObjectsForClasses: &*classes, options: &*options];
        if !urls.is_null() {
            let count: usize = msg_send![urls, count];
            for i in 0..count {
                let url: *mut AnyObject = msg_send![urls, objectAtIndex: i];
                let path: *mut NSString = msg_send![url, path];
                if !path.is_null() {
                    sent.files.push(PathBuf::from((*path).to_string()));
                }
            }
        }
        let text_of = |kind: &str| -> Option<String> {
            let kind = NSString::from_str(kind);
            let text: *mut NSString = msg_send![pasteboard, stringForType: &*kind];
            (!text.is_null()).then(|| (*text).to_string()).filter(|t| !t.trim().is_empty())
        };
        if sent.files.is_empty() {
            sent.url = text_of("public.url").filter(|u| u.starts_with("https://") || u.starts_with("http://"));
            sent.text = text_of("public.utf8-plain-text").filter(|t| Some(t) != sent.url.as_ref());
        }
    }
    sent
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test threads take turns with the pasteboard server: made at once on parallel threads,
    /// two private pasteboards once crossed over and one test read the other's content.
    static PASTEBOARDS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A pasteboard of this test's own, never the user's: made under a unique name, filled and
    /// released, one test at a time.
    fn pasteboard(fill: impl FnOnce(*mut AnyObject)) -> Sent {
        let _turn = PASTEBOARDS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: a private pasteboard; `releaseGlobally` takes it off the system after use.
        unsafe {
            let board: *mut AnyObject = msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
            let _: isize = msg_send![board, clearContents];
            fill(board);
            let sent = read(board);
            let _: () = msg_send![board, releaseGlobally];
            sent
        }
    }

    fn put(board: *mut AnyObject, kind: &str, text: &str) {
        let (kind, text) = (NSString::from_str(kind), NSString::from_str(text));
        // SAFETY: a live pasteboard and two strings.
        let _: Bool = unsafe { msg_send![board, setString: &*text, forType: &*kind] };
    }

    #[test]
    fn text_and_a_web_address_are_read_from_the_pasteboard() {
        let sent = pasteboard(|b| put(b, "public.utf8-plain-text", "shader variant stripping"));
        assert_eq!(sent, Sent { text: Some("shader variant stripping".into()), ..Sent::default() });
        let sent = pasteboard(|b| put(b, "public.url", "https://example.com/a"));
        assert_eq!(sent.url.as_deref(), Some("https://example.com/a"));
        let sent = pasteboard(|b| put(b, "public.url", "ftp://example.com/a"));
        assert_eq!(sent.url, None, "only web addresses");
    }

    #[test]
    fn files_are_read_as_paths() {
        let sent = pasteboard(|b| put(b, "public.file-url", "file:///tmp/build%20report.txt"));
        assert_eq!(sent.files, [PathBuf::from("/tmp/build report.txt")]);
        assert_eq!((sent.url, sent.text), (None, None));
    }

    #[test]
    fn the_provider_class_answers_the_service_message() {
        let class = provider_class();
        assert!(class.instance_method(sel!(sendToEos:userData:error:)).is_some());
    }
}
