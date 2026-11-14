//! The shell-side transport: one request in, a head and body chunks out, cancellation when
//! the page drops the request. No sockets, no Tauri or CEF types.
//!
//! The shell's scheme handler turns each page request into a [`Req`], makes a [`channel`],
//! hands the [`Sink`] to a [`Service`] and pulls the answer out of the [`Body`].

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

/// Who in the view made a request. The shell reads it from the browser itself (the frame
/// and the kind of load), so a page cannot claim to be something else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Initiator {
    /// The view's top-level document being loaded.
    TopLevel,
    /// The top-level document asking for something: a subresource, a fetch, an event stream.
    Document,
    /// A frame inside it (a sandboxed app, a raw file), whatever it loads; also anything
    /// the shell cannot attribute. The least trusted.
    #[default]
    Frame,
}

#[derive(Debug, Clone, Default)]
pub struct Req {
    pub initiator: Initiator,
    pub method: String,
    /// The absolute URL the page asked for. For the core it is rewritten to the
    /// origin-form target (`/path?query`).
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn set_header(&mut self, name: &str, value: &str) {
        self.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
        self.headers.push((name.to_string(), value.to_string()));
    }

    pub fn is_read(&self) -> bool {
        matches!(self.method.as_str(), "GET" | "HEAD" | "OPTIONS")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub trait Service: Send + Sync + 'static {
    /// Must not block: answer through `sink` now or later, from any thread.
    fn call(&self, req: Req, sink: Sink);
}

/// Unread bytes beyond this make [`Sink::chunk_async`] wait and [`Sink::offer`] refuse.
pub const HIGH_WATER: usize = 1 << 20;

type Waker = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct State {
    head: Option<Head>,
    /// `Sink::time_head`: a `Server-Timing` entry to add to the head, timed from then.
    timed: Option<(&'static str, std::time::Instant)>,
    head_waker: Option<Waker>,
    queue: VecDeque<Vec<u8>>,
    front_off: usize,
    queued: usize,
    done: bool,
    read_waker: Option<Waker>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    cancelled: AtomicBool,
    cancel: Notify,
    room: Notify,
}

impl Shared {
    // A panic while the lock is held leaves plain queue state behind; keep serving.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Makes the two halves of one response.
pub fn channel() -> (Sink, Body) {
    let shared = Arc::new(Shared::default());
    (Sink { shared: shared.clone() }, Body { shared })
}

/// The writing half: what a [`Service`] answers through.
#[derive(Clone)]
pub struct Sink {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Sink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sink").field("cancelled", &self.is_cancelled()).finish()
    }
}

/// What [`Sink::offer`] did with a chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Offer {
    Sent,
    /// The page is not reading: more than [`HIGH_WATER`] bytes are waiting.
    Full,
    /// The page dropped the request.
    Gone,
}

impl Sink {
    /// Sends the status line and headers. Only the first call counts.
    pub fn head(&self, mut head: Head) {
        let waker = {
            let mut st = self.shared.lock();
            if st.head.is_some() {
                return;
            }
            if let Some((name, since)) = st.timed.take() {
                let ms = since.elapsed().as_secs_f64() * 1000.0;
                head.headers.push(("server-timing".into(), format!("{name};dur={ms:.1}")));
            }
            st.head = Some(head);
            st.head_waker.take()
        };
        if let Some(waker) = waker {
            waker();
        }
    }

    /// Diagnostics: the head gets a `Server-Timing` entry `name` with the time from now until
    /// the head is sent, which the page reads from its resource timing.
    pub fn time_head(&self, name: &'static str) {
        self.shared.lock().timed = Some((name, std::time::Instant::now()));
    }

    /// Whether the head was sent already.
    pub fn has_head(&self) -> bool {
        self.shared.lock().head.is_some()
    }

    /// Queues body bytes that are already in memory. Returns false once the page dropped
    /// the request. A stream uses [`Sink::chunk_async`] or [`Sink::offer`] instead, which
    /// respect the reader's pace.
    pub fn chunk(&self, bytes: &[u8]) -> bool {
        if self.is_cancelled() {
            return false;
        }
        if bytes.is_empty() {
            return true;
        }
        let waker = {
            let mut st = self.shared.lock();
            st.queued += bytes.len();
            st.queue.push_back(bytes.to_vec());
            st.read_waker.take()
        };
        if let Some(waker) = waker {
            waker();
        }
        true
    }

    /// [`Sink::chunk`] for a live stream: never queues past [`HIGH_WATER`].
    pub fn offer(&self, bytes: &[u8]) -> Offer {
        if self.is_cancelled() {
            return Offer::Gone;
        }
        if self.shared.lock().queued >= HIGH_WATER {
            return Offer::Full;
        }
        if self.chunk(bytes) { Offer::Sent } else { Offer::Gone }
    }

    /// [`Sink::chunk`] with back-pressure: waits while [`HIGH_WATER`] bytes are unread.
    pub async fn chunk_async(&self, bytes: &[u8]) -> bool {
        loop {
            let room = self.shared.room.notified();
            if self.is_cancelled() {
                return false;
            }
            if self.shared.lock().queued < HIGH_WATER {
                return self.chunk(bytes);
            }
            tokio::select! {
                _ = room => {}
                _ = self.cancelled() => return false,
            }
        }
    }

    /// Ends the body.
    pub fn end(&self) {
        let waker = {
            let mut st = self.shared.lock();
            st.done = true;
            st.read_waker.take()
        };
        if let Some(waker) = waker {
            waker();
        }
    }

    /// A whole response at once.
    pub fn respond(&self, status: u16, mut headers: Vec<(String, String)>, body: &[u8]) {
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

    /// Resolves when the page drops the request (closes an `EventSource`, navigates away).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.shared.cancel.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// What [`Body::read`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Read {
    /// This many bytes were copied into the buffer.
    Data(usize),
    /// Nothing yet; the waker runs once there is something to read.
    Pending,
    End,
}

/// The reading half: what the shell's scheme handler pulls the response out of.
pub struct Body {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Body {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Body").finish_non_exhaustive()
    }
}

impl Body {
    /// Runs `waker` once the head is there: at once when it already is.
    pub fn on_head(&self, waker: impl FnOnce() + Send + 'static) {
        {
            let mut st = self.shared.lock();
            if st.head.is_none() {
                st.head_waker = Some(Box::new(waker));
                return;
            }
        }
        waker();
    }

    pub fn head(&self) -> Option<Head> {
        self.shared.lock().head.clone()
    }

    /// Copies queued bytes into `buf`. With nothing queued and the body still open, keeps
    /// `waker` and runs it when a chunk or the end arrives; the reader then calls
    /// [`Body::read_now`].
    pub fn read(&self, buf: &mut [u8], waker: impl FnOnce() + Send + 'static) -> Read {
        let mut st = self.shared.lock();
        let n = drain(&mut st, buf);
        if n > 0 {
            drop(st);
            self.shared.room.notify_waiters();
            return Read::Data(n);
        }
        if st.done {
            return Read::End;
        }
        st.read_waker = Some(Box::new(waker));
        Read::Pending
    }

    /// [`Body::read`] without waiting: 0 means the end (or nothing yet).
    pub fn read_now(&self, buf: &mut [u8]) -> usize {
        let n = drain(&mut self.shared.lock(), buf);
        if n > 0 {
            self.shared.room.notify_waiters();
        }
        n
    }

    /// Whether the whole body was sent and read: what is left after that is only the
    /// reader's clean-up (CEF calls `Cancel` on every request once it is done).
    pub fn finished(&self) -> bool {
        let st = self.shared.lock();
        st.done && st.queue.is_empty()
    }

    /// The page dropped the request: wakes everything waiting on the sink.
    pub fn cancel(&self) {
        self.shared.cancelled.store(true, Ordering::SeqCst);
        self.shared.cancel.notify_waiters();
        self.shared.room.notify_waiters();
        let mut st = self.shared.lock();
        st.read_waker = None;
        st.head_waker = None;
        st.queue.clear();
        st.queued = 0;
    }
}

fn drain(st: &mut State, buf: &mut [u8]) -> usize {
    let mut n = 0;
    while n < buf.len() {
        let off = st.front_off;
        let Some(front) = st.queue.front() else { break };
        let take = (front.len() - off).min(buf.len() - n);
        buf[n..n + take].copy_from_slice(&front[off..off + take]);
        n += take;
        if off + take == front.len() {
            st.queue.pop_front();
            st.front_off = 0;
        } else {
            st.front_off = off + take;
        }
    }
    st.queued = st.queued.saturating_sub(n);
    n
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use super::*;

    fn read_all(body: &Body) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 7];
        loop {
            match body.read(&mut buf, || {}) {
                Read::Data(n) => out.extend_from_slice(&buf[..n]),
                Read::Pending | Read::End => return out,
            }
        }
    }

    #[test]
    fn respond_sets_length_and_delivers_the_body_in_order() {
        let (sink, body) = channel();
        sink.respond(200, vec![("content-type".into(), "text/plain".into())], b"hello, world");
        let head = body.head().expect("head");
        assert_eq!(head.status, 200);
        assert_eq!(head.header("Content-Length"), Some("12"));
        assert_eq!(read_all(&body), b"hello, world");
        assert_eq!(body.read(&mut [0u8; 4], || {}), Read::End);
    }

    #[test]
    fn a_timed_head_carries_its_server_timing() {
        let (sink, body) = channel();
        sink.time_head("rust");
        sink.respond(200, vec![], b"");
        let head = body.head().expect("head");
        let timing = head.header("server-timing").expect("server-timing");
        assert!(timing.starts_with("rust;dur="), "{timing}");
    }

    #[test]
    fn head_waker_runs_now_or_when_the_head_arrives() {
        let (sink, body) = channel();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        body.on_head(move || {
            h.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        sink.head(Head { status: 204, headers: vec![] });
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let h = hits.clone();
        body.on_head(move || {
            h.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        // Only the first head counts.
        sink.head(Head { status: 500, headers: vec![] });
        assert_eq!(body.head().map(|h| h.status), Some(204));
    }

    #[test]
    fn a_pending_read_is_woken_by_a_chunk_and_by_the_end() {
        let (sink, body) = channel();
        let woken = Arc::new(AtomicUsize::new(0));
        let mut buf = [0u8; 8];
        let w = woken.clone();
        assert_eq!(
            body.read(&mut buf, move || {
                w.fetch_add(1, Ordering::SeqCst);
            }),
            Read::Pending
        );
        sink.chunk(b"abc");
        assert_eq!(woken.load(Ordering::SeqCst), 1);
        assert_eq!(body.read_now(&mut buf), 3);
        assert_eq!(&buf[..3], b"abc");
        let w = woken.clone();
        assert_eq!(
            body.read(&mut buf, move || {
                w.fetch_add(1, Ordering::SeqCst);
            }),
            Read::Pending
        );
        sink.end();
        assert_eq!(woken.load(Ordering::SeqCst), 2);
        assert_eq!(body.read_now(&mut buf), 0);
        assert_eq!(body.read(&mut buf, || {}), Read::End);
    }

    #[test]
    fn a_body_is_finished_once_ended_and_read() {
        let (sink, body) = channel();
        sink.head(Head { status: 200, headers: vec![] });
        sink.chunk(b"abc");
        assert!(!body.finished());
        sink.end();
        assert!(!body.finished(), "unread bytes are left");
        assert_eq!(body.read_now(&mut [0u8; 8]), 3);
        assert!(body.finished());
    }

    #[test]
    fn cancel_stops_the_sink() {
        let (sink, body) = channel();
        sink.head(Head { status: 200, headers: vec![] });
        assert!(sink.chunk(b"one"));
        body.cancel();
        assert!(sink.is_cancelled());
        assert!(!sink.chunk(b"two"));
        assert_eq!(sink.offer(b"three"), Offer::Gone);
        assert_eq!(body.read_now(&mut [0u8; 8]), 0);
    }

    #[test]
    fn offer_refuses_past_the_high_water_mark() {
        let (sink, body) = channel();
        let block = vec![0u8; HIGH_WATER / 2];
        assert_eq!(sink.offer(&block), Offer::Sent);
        assert_eq!(sink.offer(&block), Offer::Sent);
        assert_eq!(sink.offer(b"x"), Offer::Full);
        let mut buf = vec![0u8; HIGH_WATER];
        assert_eq!(body.read_now(&mut buf), HIGH_WATER);
        assert_eq!(sink.offer(b"x"), Offer::Sent);
    }

    #[tokio::test]
    async fn cancelled_resolves_for_a_waiting_stream() {
        let (sink, body) = channel();
        let waiting = tokio::spawn({
            let sink = sink.clone();
            async move { sink.cancelled().await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!waiting.is_finished());
        body.cancel();
        tokio::time::timeout(Duration::from_secs(1), waiting).await.expect("cancelled in time").expect("task");
    }

    #[tokio::test]
    async fn chunk_async_waits_for_the_reader_and_gives_up_on_cancel() {
        let (sink, body) = channel();
        assert!(sink.chunk_async(&vec![1u8; HIGH_WATER]).await);
        let blocked = tokio::spawn({
            let sink = sink.clone();
            async move { sink.chunk_async(b"tail").await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!blocked.is_finished(), "the writer must wait while the queue is full");
        let mut buf = vec![0u8; HIGH_WATER];
        assert_eq!(body.read_now(&mut buf), HIGH_WATER);
        assert!(tokio::time::timeout(Duration::from_secs(1), blocked).await.expect("in time").expect("task"));

        assert!(sink.chunk_async(&vec![1u8; HIGH_WATER]).await);
        let blocked = tokio::spawn({
            let sink = sink.clone();
            async move { sink.chunk_async(b"tail").await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        body.cancel();
        assert!(!tokio::time::timeout(Duration::from_secs(1), blocked).await.expect("in time").expect("task"));
    }
}
