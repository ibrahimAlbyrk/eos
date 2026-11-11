//! The boundary that keeps one request's panic from reaching anything else.

use std::any::Any;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::task::{Context, Poll};

/// Polls `F`, turning a panic inside it into an `Err` with the panic payload.
/// The future is dropped afterwards, never polled again.
pub(crate) struct CatchUnwind<F>(pub(crate) F);

impl<F: Future + Unpin> Future for CatchUnwind<F> {
    type Output = Result<F::Output, Box<dyn Any + Send>>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match catch_unwind(AssertUnwindSafe(|| Pin::new(&mut self.0).poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(out)) => Poll::Ready(Ok(out)),
            Err(payload) => Poll::Ready(Err(payload)),
        }
    }
}
