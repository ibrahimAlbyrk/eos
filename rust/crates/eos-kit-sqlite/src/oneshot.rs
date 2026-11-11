//! A one-value channel a thread can block on and a task can await, so the
//! crate needs no async runtime.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

struct State<T> {
    value: Option<T>,
    sender_gone: bool,
    waker: Option<Waker>,
}

struct Shared<T> {
    state: Mutex<State<T>>,
    ready: Condvar,
}

impl<T> Shared<T> {
    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub(crate) struct Sender<T>(Arc<Shared<T>>);
pub(crate) struct Receiver<T>(Arc<Shared<T>>);

pub(crate) fn channel<T>() -> (Sender<T>, Receiver<T>) {
    let shared = Arc::new(Shared {
        state: Mutex::new(State { value: None, sender_gone: false, waker: None }),
        ready: Condvar::new(),
    });
    (Sender(shared.clone()), Receiver(shared))
}

impl<T> Sender<T> {
    pub(crate) fn send(self, value: T) {
        self.0.lock().value = Some(value);
        // Drop wakes the receiver.
    }
}

impl<T> Drop for Sender<T> {
    fn drop(&mut self) {
        let waker = {
            let mut state = self.0.lock();
            state.sender_gone = true;
            state.waker.take()
        };
        self.0.ready.notify_all();
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<T> Receiver<T> {
    /// Blocks until the value arrives; `None` when the sender went away without one.
    pub(crate) fn wait(self) -> Option<T> {
        let mut state = self.0.lock();
        while state.value.is_none() && !state.sender_gone {
            state = self.0.ready.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
        state.value.take()
    }
}

impl<T> Future for Receiver<T> {
    type Output = Option<T>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self.0.lock();
        if state.value.is_some() || state.sender_gone {
            return Poll::Ready(state.value.take());
        }
        state.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}
