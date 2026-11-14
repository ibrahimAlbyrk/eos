//! A panic in any thread is written to the log, with where it happened, before the
//! process acts on it (unwinds to a catch boundary, or ends).

use std::cell::Cell;
use std::time::Duration;

/// The panic's own text is cut to this: it may quote data.
const MESSAGE_CHARS: usize = 300;

thread_local! {
    static IN_HOOK: Cell<bool> = const { Cell::new(false) };
}

/// Puts the log in front of the current panic hook (which still runs after it).
pub fn catch_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic inside the log itself must not come back here.
        if !IN_HOOK.with(|h| h.replace(true)) {
            let thread = std::thread::current();
            let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            let message: String = message.chars().take(MESSAGE_CHARS).collect();
            tracing::error!(target: "eos::panic", thread = thread.name().unwrap_or("unnamed"), %location, "a thread panicked: {message}");
            crate::flush(Duration::from_millis(500));
            IN_HOOK.with(|h| h.set(false));
        }
        previous(info);
    }));
}
