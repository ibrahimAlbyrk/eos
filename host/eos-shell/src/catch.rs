//! The panic boundary of code the browser engine or AppKit calls: their callbacks are C
//! functions, and a panic unwinding out of one aborts the whole app with every agent in it.

use std::panic::{AssertUnwindSafe, catch_unwind};

/// Runs `f`, a callback's body. A panic is caught, logged (the app's panic hook has recorded
/// it with its backtrace already) and answered with `fallback` instead.
pub(crate) fn guarded<T>(what: &str, f: impl FnOnce() -> T, fallback: impl FnOnce() -> T) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => value,
        Err(_) => {
            crate::log::log("panic", &format!("{what} panicked; answered without it"));
            fallback()
        }
    }
}
