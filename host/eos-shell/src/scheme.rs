//! The in-process transport: a raw CEF scheme handler on the app's own origin.
//!
//! Tauri's `register_uri_scheme_protocol` answers with one whole body (no streaming), has no
//! `skip` (so a Range past byte 0 fails) and injects Tauri's scripts into every HTML document
//! it serves. This is the replacement: a `SchemeHandlerFactory` registered on the dashboard
//! view's own request context for `http://<host>`, whose `ResourceHandler` pulls a streamed
//! response out of a [`Service`]. No socket is involved.

use std::os::raw::c_int;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use eos_bridge::in_order::InOrder;
use eos_bridge::transport::{Body, Initiator, Read, Req, Service, Sink, channel};
use tauri_runtime_cef::cef::{self, *};

use crate::catch::guarded;
use crate::native::buffer::{OutBuf, SendCallback};

/// Requests opened, and dropped by the page before their answer was read whole (a closed
/// `EventSource`, a navigation), for diagnostics. CEF calls `cancel` on every request once
/// it is done too; those are not counted.
pub(crate) static OPENED: AtomicU64 = AtomicU64::new(0);
pub(crate) static CANCELLED: AtomicU64 = AtomicU64::new(0);

/// `EOS_SHELL_TRACE=1` logs every request's method, path (never the query) and status.
fn tracing() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("EOS_SHELL_TRACE").is_some())
}

fn trace(message: impl FnOnce() -> String) {
    if tracing() {
        crate::log::log("request", &message());
    }
}

/// Every request goes to the service in the order it was opened, a form upload's included.
static UPLOADS: std::sync::LazyLock<Arc<InOrder>> = std::sync::LazyLock::new(Arc::default);

/// One response in flight: the sink waits here until `open` hands it to the service.
struct Exchange {
    initiator: Initiator,
    sink: Mutex<Option<Sink>>,
    body: Body,
}

/// The fetch destination of a request, as the `Sec-Fetch-Dest` header would name it.
/// Chromium adds that header in its network stack, below this handler, so the shell states
/// it itself from the kind of load: routes that refuse a navigation rely on it.
fn destination(request: &Request) -> &'static str {
    use sys::cef_resource_type_t as T;
    match request.resource_type().as_ref() {
        T::RT_MAIN_FRAME | T::RT_NAVIGATION_PRELOAD_MAIN_FRAME => "document",
        T::RT_SUB_FRAME | T::RT_NAVIGATION_PRELOAD_SUB_FRAME => "iframe",
        T::RT_STYLESHEET => "style",
        T::RT_SCRIPT => "script",
        T::RT_IMAGE | T::RT_FAVICON => "image",
        T::RT_FONT_RESOURCE => "font",
        T::RT_OBJECT => "object",
        T::RT_MEDIA => "video",
        T::RT_WORKER => "worker",
        T::RT_SHARED_WORKER => "sharedworker",
        T::RT_SERVICE_WORKER => "serviceworker",
        T::RT_CSP_REPORT => "report",
        _ => "empty",
    }
}

/// Who is asking, from what the browser itself knows: the frame and the kind of load.
fn initiator(frame: Option<&mut Frame>, request: Option<&mut Request>) -> Initiator {
    let from_main_frame = frame.is_some_and(|frame| frame.is_main() != 0);
    let navigation = request
        .is_some_and(|request| matches!(request.resource_type().as_ref(), sys::cef_resource_type_t::RT_MAIN_FRAME));
    match (from_main_frame, navigation) {
        (true, true) => Initiator::TopLevel,
        (true, false) => Initiator::Document,
        (false, _) => Initiator::Frame,
    }
}

/// A request body as CEF holds it: bytes copied out once, and the files a form upload names,
/// in their order.
#[derive(Default)]
struct Upload {
    body: Vec<u8>,
    /// Each file with the length of `body` it goes after.
    files: Vec<(usize, String)>,
}

impl Upload {
    /// The whole body: the files read in their places. Blocks on the disk.
    fn read_files(self) -> Vec<u8> {
        let Upload { body, files } = self;
        let mut whole = Vec::with_capacity(body.len());
        let mut at = 0;
        for (place, path) in files {
            whole.extend_from_slice(&body[at..place]);
            at = place;
            // A form upload names the file; the page's process already had the user's leave
            // to read it.
            if let Ok(bytes) = std::fs::read(&path) {
                whole.extend(bytes);
            }
        }
        whole.extend_from_slice(&body[at..]);
        whole
    }
}

fn read_body(request: &mut Request) -> Upload {
    let mut upload = Upload::default();
    let Some(post_data) = request.post_data() else { return upload };
    let mut elements = vec![None; post_data.element_count()];
    post_data.elements(Some(&mut elements));
    for element in elements.into_iter().flatten() {
        match element.get_type().as_ref() {
            sys::cef_postdataelement_type_t::PDE_TYPE_BYTES => {
                let size = element.bytes_count();
                if size > 0 {
                    // Straight into the body: one copy.
                    let start = upload.body.len();
                    upload.body.resize(start + size, 0);
                    let copied = element.bytes(size, upload.body[start..].as_mut_ptr());
                    upload.body.truncate(start + copied.min(size));
                }
            }
            sys::cef_postdataelement_type_t::PDE_TYPE_FILE => {
                upload.files.push((upload.body.len(), CefString::from(&element.file()).to_string()));
            }
            _ => {}
        }
    }
    upload
}

fn read_headers(request: &mut Request) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut map = CefStringMultimap::new();
    request.header_map(Some(&mut map));
    for (name, values) in map {
        for value in values {
            out.push((name.clone(), value));
        }
    }
    out
}

wrap_resource_handler! {
    struct Handler {
        service: Arc<dyn Service>,
        exchange: Arc<Exchange>,
    }

    impl ResourceHandler {
        fn open(
            &self,
            request: Option<&mut Request>,
            handle_request: Option<&mut c_int>,
            callback: Option<&mut Callback>,
        ) -> c_int {
            // A panic before the service has the request leaves it unanswered: 0 cancels it,
            // and the head callback it may have registered goes with the body.
            guarded("a request's open", || self.open_request(request, handle_request, callback), || {
                self.exchange.body.cancel();
                0
            })
        }

        fn response_headers(
            &self,
            response: Option<&mut Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            let Some(response) = response else { return };
            let mut length: i64 = -1;
            let written = guarded("a response's head", || {
                self.write_head(response, &mut length);
                true
            }, || false);
            if !written {
                response.set_status(500);
            }
            if let Some(response_length) = response_length {
                *response_length = length;
            }
        }

        // CEF applies a request's Range itself by calling skip(first byte) and then reading
        // the range's length. The service already answered 206 with the sliced body, so the
        // skip is acknowledged without dropping anything.
        fn skip(
            &self,
            bytes_to_skip: i64,
            bytes_skipped: Option<&mut i64>,
            _callback: Option<&mut ResourceSkipCallback>,
        ) -> c_int {
            if let Some(bytes_skipped) = bytes_skipped {
                *bytes_skipped = bytes_to_skip;
            }
            1
        }

        fn read(
            &self,
            data_out: *mut u8,
            bytes_to_read: c_int,
            bytes_read: Option<&mut c_int>,
            callback: Option<&mut ResourceReadCallback>,
        ) -> c_int {
            // A panic ends the body: no bytes, no more to come. A read it left pending would
            // write into CEF's buffer after CEF let go of it: its waker goes with the body.
            let (n, more) = guarded("a response's read", || self.read_body(data_out, bytes_to_read, callback), || {
                self.exchange.body.cancel();
                (0, 0)
            });
            if let Some(bytes_read) = bytes_read {
                *bytes_read = c_int::try_from(n).unwrap_or(0);
            }
            more
        }

        fn cancel(&self) {
            guarded("a request's cancel", || {
                if !self.exchange.body.finished() {
                    CANCELLED.fetch_add(1, Ordering::Relaxed);
                }
                trace(|| "cancelled".to_string());
                // Drops the pending read's waker, and with it the last copy of CEF's buffer.
                self.exchange.body.cancel();
            }, || ());
        }
    }
}

impl Handler {
    fn open_request(
        &self,
        request: Option<&mut Request>,
        handle_request: Option<&mut c_int>,
        callback: Option<&mut Callback>,
    ) -> c_int {
        let (Some(request), Some(callback)) = (request, callback) else { return 0 };
        let Some(sink) = self.exchange.sink.lock().ok().and_then(|mut s| s.take()) else { return 0 };
        OPENED.fetch_add(1, Ordering::Relaxed);
        let mut upload = read_body(request);
        let mut req = Req {
            initiator: self.exchange.initiator,
            method: CefString::from(&request.method()).to_string(),
            url: CefString::from(&request.url()).to_string(),
            headers: read_headers(request),
            body: if upload.files.is_empty() { std::mem::take(&mut upload.body) } else { Vec::new() },
        };
        req.set_header("sec-fetch-dest", destination(request));
        trace(|| {
            let names: Vec<&str> = req.headers.iter().map(|(name, _)| name.as_str()).collect();
            format!(
                "{:?} {} {} [{}]",
                req.initiator,
                req.method,
                req.url.split('?').next().unwrap_or(""),
                names.join(" ")
            )
        });
        // Asynchronous: the request continues once the service sent the head.
        if let Some(handle_request) = handle_request {
            *handle_request = 0;
        }
        let callback = SendCallback(callback.clone());
        self.exchange.body.on_head(move || callback.0.cont());
        let service = self.service.clone();
        if upload.files.is_empty() {
            UPLOADS.now(move || service.call(req, sink));
            return 1;
        }
        // The files a form names are read off CEF's IO thread: it carries every request.
        // Requests that come after it wait for it, as when the files were read here.
        let upload = move || {
            let mut req = req;
            req.body = upload.read_files();
            service.call(req, sink);
        };
        UPLOADS.slow(upload, |job| std::thread::Builder::new().name("eos-upload".to_owned()).spawn(job).is_ok());
        1
    }

    fn write_head(&self, response: &mut Response, length: &mut i64) {
        let Some(head) = self.exchange.body.head() else {
            response.set_status(502);
            return;
        };
        trace(|| format!("-> {}", head.status));
        response.set_status(c_int::from(head.status));
        for (name, value) in &head.headers {
            if name.eq_ignore_ascii_case("content-length") {
                *length = value.parse().unwrap_or(-1);
            }
            if name.eq_ignore_ascii_case("content-type") {
                let mime = value.split(';').next().unwrap_or("").trim();
                response.set_mime_type(Some(&CefString::from(mime)));
            }
            response.set_header_by_name(
                Some(&CefString::from(name.as_str())),
                Some(&CefString::from(value.as_str())),
                0,
            );
        }
    }

    /// The bytes read and whether more come (1) or the body ended (0).
    fn read_body(
        &self,
        data_out: *mut u8,
        bytes_to_read: c_int,
        callback: Option<&mut ResourceReadCallback>,
    ) -> (usize, c_int) {
        let Some(callback) = callback else { return (0, 0) };
        let out = OutBuf::new(data_out, usize::try_from(bytes_to_read).unwrap_or(0));
        let callback = SendCallback(callback.clone());
        let exchange = self.exchange.clone();
        // With nothing queued the read stays pending: CEF keeps the buffer until the
        // callback continues with the byte count (0 = end).
        let waker = move || {
            let n = out.fill(|buf| exchange.body.read_now(buf));
            callback.0.cont(c_int::try_from(n).unwrap_or(0));
        };
        let read = out.fill_read(&self.exchange.body, waker);
        trace(|| format!("read({bytes_to_read}) -> {read:?}"));
        match read {
            Read::Data(n) => (n, 1),
            Read::Pending => (0, 1),
            Read::End => (0, 0),
        }
    }
}

wrap_scheme_handler_factory! {
    struct Factory {
        service: Arc<dyn Service>,
    }

    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            let exchange = guarded("a request's handler", || {
                let (sink, body) = channel();
                let initiator = initiator(frame, request);
                Exchange { initiator, sink: Mutex::new(Some(sink)), body }
            }, || {
                // No sink: `open` cancels the request rather than let it reach the network.
                let (_, body) = channel();
                Exchange { initiator: Initiator::Frame, sink: Mutex::new(None), body }
            });
            Some(Handler::new(self.service.clone(), Arc::new(exchange)))
        }
    }
}

/// Registers `service` for `http://<host>` on the browser's own request context: only that
/// view's pages reach it.
pub(crate) fn register(browser: &cef::Browser, hosts: &[&str], service: Arc<dyn Service>) -> Result<(), String> {
    let host = browser.host().ok_or("no browser host")?;
    let request_context = host.request_context().ok_or("no request context")?;
    for name in hosts {
        let mut factory = Factory::new(service.clone());
        let ok = request_context.register_scheme_handler_factory(
            Some(&CefString::from("http")),
            Some(&CefString::from(*name)),
            Some(&mut factory),
        );
        if ok != 1 {
            return Err(format!("register_scheme_handler_factory({name}) -> {ok}"));
        }
    }
    Ok(())
}
