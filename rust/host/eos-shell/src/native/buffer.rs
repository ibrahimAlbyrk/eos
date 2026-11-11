//! The raw pieces of CEF's resource handler contract.

/// The buffer CEF passes to `ResourceHandler::read`. CEF keeps it valid until the read is
/// answered (the callback continues) or the request is cancelled; the scheme handler drops
/// every copy on cancel, before CEF frees the buffer.
#[derive(Clone, Copy)]
pub(crate) struct OutBuf {
    ptr: *mut u8,
    len: usize,
}

// The buffer is only written by whoever answers the pending read, one writer at a time.
unsafe impl Send for OutBuf {}

impl OutBuf {
    /// `ptr` must be the `data_out` of a `read` call and `len` its `bytes_to_read`.
    pub(crate) fn new(ptr: *mut u8, len: usize) -> Self {
        OutBuf { ptr, len: if ptr.is_null() { 0 } else { len } }
    }

    /// Lets `fill` write into the buffer; returns what it returns (the bytes written).
    pub(crate) fn fill(self, fill: impl FnOnce(&mut [u8]) -> usize) -> usize {
        if self.len == 0 {
            return fill(&mut []);
        }
        // SAFETY: see the type's contract: valid for `len` bytes, exclusive to this writer.
        let slice = unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) };
        fill(slice)
    }
}

impl OutBuf {
    /// Reads from `body` into the buffer; when nothing is queued, `waker` is kept and run
    /// once there is.
    pub(crate) fn fill_read(
        self,
        body: &eos_bridge::transport::Body,
        waker: impl FnOnce() + Send + 'static,
    ) -> eos_bridge::transport::Read {
        if self.len == 0 {
            return body.read(&mut [], waker);
        }
        // SAFETY: as in `fill`.
        let slice = unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) };
        body.read(slice, waker)
    }
}

/// A CEF callback object moved to the thread that answers. CEF's callbacks are
/// reference-counted and documented as callable from any thread.
pub(crate) struct SendCallback<T>(pub(crate) T);

// SAFETY: see above; the wrapped object is only used to call its `cont`.
unsafe impl<T> Send for SendCallback<T> {}
