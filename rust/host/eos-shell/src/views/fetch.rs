//! A GET the browser process makes with one profile's stored cookies, what Electron's
//! `session.fetch` did: no page takes part. Used for the site's account page of a Claude
//! sign-in's profile.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use tauri_runtime_cef::WebviewCefExt;
use tauri_runtime_cef::cef::{self, *};
use tokio::sync::oneshot;

use crate::native::buffer::received;

/// The largest answer kept: an account document is a few kilobytes.
const MAX_BODY: usize = 64 * 1024;
/// `UR_FLAG_ALLOW_STORED_CREDENTIALS`: the profile's cookies go with the request.
const STORED_CREDENTIALS: i32 = 8;

struct Collected {
    body: Vec<u8>,
    too_big: bool,
    done: Option<oneshot::Sender<Option<Vec<u8>>>>,
    /// The request, kept until it completes.
    request: Option<Urlrequest>,
}

wrap_urlrequest_client! {
    struct Collect {
        state: Rc<RefCell<Collected>>,
    }

    impl UrlrequestClient {
        fn on_download_data(&self, _request: Option<&mut Urlrequest>, data: *const u8, data_length: usize) {
            let bytes = received(data, data_length);
            let mut st = self.state.borrow_mut();
            if st.body.len() + bytes.len() > MAX_BODY {
                st.too_big = true;
            } else {
                st.body.extend_from_slice(&bytes);
            }
        }

        fn on_request_complete(&self, request: Option<&mut Urlrequest>) {
            let ok = request.is_some_and(|r| {
                r.request_status() == UrlrequestStatus::SUCCESS && r.response().is_some_and(|resp| resp.status() == 200)
            });
            let mut st = self.state.borrow_mut();
            let body = (ok && !st.too_big).then(|| std::mem::take(&mut st.body));
            st.request = None;
            if let Some(done) = st.done.take() {
                let _ = done.send(body);
            }
        }
    }
}

/// GETs `url` in the request context of `webview`'s profile, with its stored cookies.
/// The body of a 200 answer; `None` for anything else or after `timeout`.
pub(crate) async fn get(webview: &tauri::Webview, url: &str, timeout: Duration) -> Option<Vec<u8>> {
    let (done, answer) = oneshot::channel();
    let url = url.to_owned();
    // On the browser's UI thread, where CEF also calls the client back.
    webview
        .with_cef_webview(move |w| {
            let Some(mut context) = w.browser().host().and_then(|host| host.request_context()) else { return };
            let Some(mut request) = cef::request_create() else { return };
            request.set_url(Some(&CefString::from(url.as_str())));
            request.set_method(Some(&CefString::from("GET")));
            request.set_header_by_name(Some(&CefString::from("Accept")), Some(&CefString::from("application/json")), 1);
            request.set_flags(STORED_CREDENTIALS);
            let state =
                Rc::new(RefCell::new(Collected { body: Vec::new(), too_big: false, done: Some(done), request: None }));
            let mut client = Collect::new(state.clone());
            let started = cef::urlrequest_create(Some(&mut request), Some(&mut client), Some(&mut context));
            let mut st = state.borrow_mut();
            if st.done.is_some() {
                st.request = started;
            }
        })
        .ok()?;
    tokio::time::timeout(timeout, answer).await.ok()?.ok()?
}
