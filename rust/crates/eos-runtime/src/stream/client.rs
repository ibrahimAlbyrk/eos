//! One connected stream: its queue, and the body a transport pulls it through.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::Bytes;
use futures_core::Stream;
use tokio::time::{Instant, Interval, MissedTickBehavior, interval_at};

use super::Hub;
use super::filter::Wants;
use crate::http::BodyError;

pub(super) const KEEPALIVE_FRAME: &[u8] = b":ka\n\n";

struct Queue {
    frames: VecDeque<Bytes>,
    /// Frames at the front that are the attach preamble or the replay: they
    /// were owed to the client, so they do not count against its live bound.
    owed: usize,
    live_frames: usize,
    live_bytes: usize,
    ended: bool,
    waker: Option<Waker>,
}

pub(super) struct Client {
    pub(super) id: u64,
    pub(super) wants: Wants,
    /// The dashboard tab this stream belongs to.
    pub(super) tab: Option<Arc<str>>,
    queue: Mutex<Queue>,
}

impl Client {
    pub(super) fn new(id: u64, wants: Wants, tab: Option<Arc<str>>, owed: Vec<Bytes>) -> Self {
        let queue =
            Queue { owed: owed.len(), frames: owed.into(), live_frames: 0, live_bytes: 0, ended: false, waker: None };
        Self { id, wants, tab, queue: Mutex::new(queue) }
    }

    // The queue stays valid at every step, so a poisoned lock is safe to use.
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Queues a live frame. `false`: the client is too far behind — it is
    /// ended instead of resumed with a hole, and reconnects from its last id.
    pub(super) fn push(&self, frame: &Bytes, max_frames: usize, max_bytes: usize) -> bool {
        let mut q = self.queue();
        if q.ended {
            return false;
        }
        // A frame larger than the whole budget still goes to a client that
        // has caught up, or it could never receive it.
        let full = q.live_frames >= max_frames || (q.live_frames > 0 && q.live_bytes + frame.len() > max_bytes);
        if full {
            q.ended = true;
        } else {
            q.live_frames += 1;
            q.live_bytes += frame.len();
            q.frames.push_back(frame.clone());
        }
        let waker = q.waker.take();
        drop(q);
        if let Some(waker) = waker {
            waker.wake();
        }
        !full
    }

    pub(super) fn is_ended(&self) -> bool {
        self.queue().ended
    }

    /// Ends the stream once the client has read what is queued.
    pub(super) fn end(&self) {
        let mut q = self.queue();
        q.ended = true;
        let waker = q.waker.take();
        drop(q);
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

/// The response body of one stream. Pulling it is the back-pressure; dropping
/// it (the caller went away) removes the stream from the hub.
pub(super) struct ClientStream {
    hub: Weak<Hub>,
    client: Arc<Client>,
    keepalive: Pin<Box<Interval>>,
}

impl ClientStream {
    pub(super) fn new(hub: &Arc<Hub>, client: Arc<Client>, keepalive: Duration) -> Self {
        let mut ticks = interval_at(Instant::now() + keepalive, keepalive);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Self { hub: Arc::downgrade(hub), client, keepalive: Box::pin(ticks) }
    }
}

impl Stream for ClientStream {
    type Item = Result<Bytes, BodyError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        {
            let mut q = self.client.queue();
            if let Some(frame) = q.frames.pop_front() {
                if q.owed > 0 {
                    q.owed -= 1;
                } else {
                    q.live_frames -= 1;
                    q.live_bytes -= frame.len();
                }
                return Poll::Ready(Some(Ok(frame)));
            }
            if q.ended {
                return Poll::Ready(None);
            }
            q.waker = Some(cx.waker().clone());
        }
        // Keepalive comments keep an idle stream warm through whatever sits
        // between the app and the client (a relay, a peer link).
        if self.keepalive.as_mut().poll_tick(cx).is_ready() {
            return Poll::Ready(Some(Ok(Bytes::from_static(KEEPALIVE_FRAME))));
        }
        Poll::Pending
    }
}

impl Drop for ClientStream {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.detach(&self.client);
        }
    }
}
