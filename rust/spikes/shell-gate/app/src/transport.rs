// In-process transport: a raw CEF scheme handler on the app's own origin.
//
// Tauri's `register_uri_scheme_protocol` answers with one whole body (no streaming) and its
// resource handler has no `skip`, so a Range request past byte 0 fails. This module is the
// replacement: a `SchemeHandlerFactory` registered on the view's request context for
// `http://<host>`, whose `ResourceHandler` pulls a streamed response out of a `Service`.
//
// `Service` is what the core's router looks like from the shell: one request in, a head and
// body chunks out, cancellation when the page drops the request. Nothing here knows HTTP
// sockets; the gate's `Service` happens to proxy to the isolated Node daemon (proxy.rs).
use std::{
  collections::VecDeque,
  os::raw::c_int,
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
  },
};

use tauri_runtime_cef::cef::{self, *};

pub struct Req {
  pub method: String,
  pub url: String,
  pub headers: Vec<(String, String)>,
  pub body: Vec<u8>,
}

impl Req {
  pub fn header(&self, name: &str) -> Option<&str> {
    self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
  }
}

pub struct Head {
  pub status: u16,
  pub headers: Vec<(String, String)>,
}

pub trait Service: Send + Sync + 'static {
  /// Must not block: answer through `sink` now or later, from any thread.
  fn call(&self, req: Req, sink: Sink);
}

struct SendPtr(*mut u8);
unsafe impl Send for SendPtr {}
struct SendCb<T>(T);
unsafe impl<T> Send for SendCb<T> {}

#[derive(Default)]
struct State {
  head: Option<Head>,
  open_cb: Option<SendCb<Callback>>,
  queue: VecDeque<Vec<u8>>,
  front_off: usize,
  queued: usize,
  done: bool,
  // A read CEF is waiting on: its buffer stays valid until the callback runs.
  waiting: Option<(SendPtr, usize, SendCb<ResourceReadCallback>)>,
}

struct Shared {
  state: Mutex<State>,
  cancelled: AtomicBool,
  cancel: tokio::sync::Notify,
  room: tokio::sync::Notify,
}

/// Chunks queued beyond this make `Sink::chunk_async` wait for the page to read.
const HIGH_WATER: usize = 1 << 20;

#[derive(Clone)]
pub struct Sink {
  shared: Arc<Shared>,
}

impl Sink {
  pub fn head(&self, head: Head) {
    let cb = {
      let mut st = self.shared.state.lock().unwrap();
      st.head = Some(head);
      st.open_cb.take()
    };
    if let Some(cb) = cb {
      cb.0.cont();
    }
  }

  /// Returns false once the page cancelled the request.
  pub fn chunk(&self, bytes: &[u8]) -> bool {
    if self.is_cancelled() {
      return false;
    }
    if bytes.is_empty() {
      return true;
    }
    let mut st = self.shared.state.lock().unwrap();
    if let Some((ptr, cap, cb)) = st.waiting.take() {
      let n = bytes.len().min(cap);
      unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.0, n) };
      if n < bytes.len() {
        st.queued += bytes.len() - n;
        st.queue.push_back(bytes[n..].to_vec());
      }
      drop(st);
      cb.0.cont(n as c_int);
    } else {
      st.queued += bytes.len();
      st.queue.push_back(bytes.to_vec());
    }
    true
  }

  /// `chunk` with back-pressure: waits while more than `HIGH_WATER` bytes are unread.
  pub async fn chunk_async(&self, bytes: &[u8]) -> bool {
    loop {
      let room = self.shared.room.notified();
      if self.is_cancelled() {
        return false;
      }
      if self.shared.state.lock().unwrap().queued < HIGH_WATER {
        return self.chunk(bytes);
      }
      tokio::select! { _ = room => {}, _ = self.cancelled() => return false }
    }
  }

  pub fn end(&self) {
    let waiting = {
      let mut st = self.shared.state.lock().unwrap();
      st.done = true;
      if st.queue.is_empty() { st.waiting.take() } else { None }
    };
    if let Some((_, _, cb)) = waiting {
      cb.0.cont(0);
    }
  }

  /// Whole response at once.
  pub fn respond(&self, status: u16, headers: Vec<(String, String)>, body: &[u8]) {
    let mut headers = headers;
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-length")) {
      headers.push(("content-length".into(), body.len().to_string()));
    }
    self.head(Head { status, headers });
    self.chunk(body);
    self.end();
  }

  pub fn is_cancelled(&self) -> bool {
    self.shared.cancelled.load(Ordering::SeqCst)
  }

  pub async fn cancelled(&self) {
    loop {
      let n = self.shared.cancel.notified();
      if self.is_cancelled() {
        return;
      }
      n.await;
    }
  }
}

pub static REQUESTS: AtomicU64 = AtomicU64::new(0);
pub static CANCELS: AtomicU64 = AtomicU64::new(0);

fn read_body(request: &mut Request) -> Vec<u8> {
  let mut body = Vec::new();
  if let Some(post_data) = request.post_data() {
    let mut elements = vec![None; post_data.element_count()];
    post_data.elements(Some(&mut elements));
    for element in elements.into_iter().flatten() {
      match element.get_type().as_ref() {
        sys::cef_postdataelement_type_t::PDE_TYPE_BYTES => {
          let size = element.bytes_count();
          if size > 0 {
            let mut buf = vec![0u8; size];
            let copied = element.bytes(size, buf.as_mut_ptr());
            buf.truncate(copied);
            body.extend(buf);
          }
        }
        sys::cef_postdataelement_type_t::PDE_TYPE_FILE => {
          let path = CefString::from(&element.file()).to_string();
          if let Ok(bytes) = std::fs::read(&path) {
            body.extend(bytes);
          }
        }
        _ => {}
      }
    }
  }
  body
}

fn read_headers(request: &mut Request) -> Vec<(String, String)> {
  let mut out = Vec::new();
  let mut map = CefStringMultimap::new();
  request.header_map(Some(&mut map));
  for (name, values) in map {
    for v in values {
      out.push((name.clone(), v));
    }
  }
  out
}

wrap_resource_handler! {
  pub struct BridgeHandler {
    service: Arc<dyn Service>,
    shared: Arc<Shared>,
  }

  impl ResourceHandler {
    fn open(
      &self,
      request: Option<&mut Request>,
      handle_request: Option<&mut c_int>,
      callback: Option<&mut Callback>,
    ) -> c_int {
      let (Some(request), Some(callback)) = (request, callback) else { return 0 };
      REQUESTS.fetch_add(1, Ordering::Relaxed);
      let req = Req {
        method: CefString::from(&request.method()).to_string(),
        url: CefString::from(&request.url()).to_string(),
        headers: read_headers(request),
        body: read_body(request),
      };
      self.shared.state.lock().unwrap().open_cb = Some(SendCb(callback.clone()));
      // Asynchronous: the head arrives through `Sink::head`, which continues the request.
      if let Some(handle_request) = handle_request {
        *handle_request = 0;
      }
      self.service.call(req, Sink { shared: self.shared.clone() });
      1
    }

    fn response_headers(
      &self,
      response: Option<&mut Response>,
      response_length: Option<&mut i64>,
      _redirect_url: Option<&mut CefString>,
    ) {
      let Some(response) = response else { return };
      let st = self.shared.state.lock().unwrap();
      let Some(head) = st.head.as_ref() else {
        response.set_status(502);
        return;
      };
      response.set_status(head.status as c_int);
      let mut length: i64 = -1;
      let mut mime = None;
      for (name, value) in &head.headers {
        let lower = name.to_ascii_lowercase();
        if lower == "content-length" {
          length = value.parse().unwrap_or(-1);
        }
        if lower == "content-type" {
          mime = Some(value.split(';').next().unwrap_or("").trim().to_string());
        }
        response.set_header_by_name(Some(&CefString::from(name.as_str())), Some(&CefString::from(value.as_str())), 0);
      }
      if let Some(mime) = mime {
        response.set_mime_type(Some(&CefString::from(mime.as_str())));
      }
      if let Some(response_length) = response_length {
        *response_length = length;
      }
    }

    // CEF applies a request's Range itself by calling skip(first byte) and then reading the
    // range length. The service already answered 206 with the sliced body, so the skip is
    // acknowledged without dropping anything.
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
      let cap = bytes_to_read.max(0) as usize;
      let mut st = self.shared.state.lock().unwrap();
      let mut n = 0usize;
      while n < cap {
        let off = st.front_off;
        let Some(front) = st.queue.front() else { break };
        let take = (front.len() - off).min(cap - n);
        unsafe { std::ptr::copy_nonoverlapping(front.as_ptr().add(off), data_out.add(n), take) };
        n += take;
        if off + take == front.len() {
          st.queue.pop_front();
          st.front_off = 0;
        } else {
          st.front_off = off + take;
        }
      }
      if n > 0 {
        st.queued = st.queued.saturating_sub(n);
        drop(st);
        self.shared.room.notify_waiters();
        if let Some(bytes_read) = bytes_read {
          *bytes_read = n as c_int;
        }
        return 1;
      }
      if let Some(bytes_read) = bytes_read {
        *bytes_read = 0;
      }
      if st.done {
        return 0;
      }
      let Some(callback) = callback else { return 0 };
      st.waiting = Some((SendPtr(data_out), cap, SendCb(callback.clone())));
      1
    }

    fn cancel(&self) {
      CANCELS.fetch_add(1, Ordering::Relaxed);
      self.shared.cancelled.store(true, Ordering::SeqCst);
      self.shared.cancel.notify_waiters();
      self.shared.room.notify_waiters();
      let mut st = self.shared.state.lock().unwrap();
      st.waiting = None;
      st.open_cb = None;
    }
  }
}

wrap_scheme_handler_factory! {
  pub struct BridgeFactory {
    service: Arc<dyn Service>,
  }

  impl SchemeHandlerFactory {
    fn create(
      &self,
      _browser: Option<&mut Browser>,
      _frame: Option<&mut Frame>,
      _scheme_name: Option<&CefString>,
      _request: Option<&mut Request>,
    ) -> Option<ResourceHandler> {
      Some(BridgeHandler::new(
        self.service.clone(),
        Arc::new(Shared {
          state: Mutex::new(State::default()),
          cancelled: AtomicBool::new(false),
          cancel: tokio::sync::Notify::new(),
          room: tokio::sync::Notify::new(),
        }),
      ))
    }
  }
}

/// Registers `service` for `http://<host>` on the browser's own request context.
pub fn register(browser: &cef::Browser, hosts: &[&str], service: Arc<dyn Service>) -> Result<(), String> {
  let host = browser.host().ok_or("no browser host")?;
  let request_context = host.request_context().ok_or("no request context")?;
  for name in hosts {
    let mut factory = BridgeFactory::new(service.clone());
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
