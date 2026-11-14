//! A view's profile is loaded before the view is made.
//!
//! The runtime makes a view on the UI thread and spins that thread on CEF's message loop
//! until the view's profile is ready. A profile that is not loaded yet is opened from disk
//! by Chromium's threads (preferences, cookies, history: tens to hundreds of milliseconds),
//! and for all of that time the window neither draws nor takes input. So the profile is
//! loaded first, with the UI thread free; the runtime then finds it loaded (CEF shares one
//! profile between every request context of a cache path) and only makes the view.

use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;
use tauri_runtime_cef::cef::{self, *};

/// Longer than a profile ever takes to open; past it the view is made anyway.
const PATIENCE: Duration = Duration::from_secs(10);

wrap_request_context_handler! {
    struct Ready {
        done: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    }

    impl RequestContextHandler {
        fn on_request_context_initialized(&self, _request_context: Option<&mut RequestContext>) {
            if let Some(done) = self.done.lock().ok().and_then(|mut done| done.take()) {
                let _ = done.send(());
            }
        }
    }
}

/// Keeps a loaded profile open until the view that uses it holds it too.
pub(crate) struct Loaded {
    _context: Option<RequestContext>,
}

/// Loads the profile at `cache_path` and waits until it is ready. Blocking, and never on the
/// main thread: the main thread only starts the load.
pub(crate) fn load(app: &tauri::AppHandle, cache_path: &Path) -> Loaded {
    let (done, ready) = mpsc::channel();
    let (handed, context) = mpsc::channel();
    let path = cache_path.to_string_lossy().into_owned();
    let started = app.run_on_main_thread(move || {
        let settings = RequestContextSettings { cache_path: CefString::from(path.as_str()), ..Default::default() };
        let mut handler = Ready::new(Arc::new(Mutex::new(Some(done))));
        let _ = handed.send(cef::request_context_create_context(Some(&settings), Some(&mut handler)));
    });
    if started.is_err() {
        return Loaded { _context: None };
    }
    let context = context.recv_timeout(PATIENCE).ok().flatten();
    if context.is_some() {
        let _ = ready.recv_timeout(PATIENCE);
    }
    Loaded { _context: context }
}
