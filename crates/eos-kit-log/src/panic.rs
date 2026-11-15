//! A panic in any thread is written to the log, with where it happened and the backtrace
//! (code places only), before the process acts on it (unwinds to a catch boundary, or ends).

use std::cell::Cell;
use std::time::Duration;

/// The backtrace keeps at most this many of Eos's own frames (a log line is bounded).
const FRAMES: usize = 24;
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
            let backtrace = own_frames(&std::backtrace::Backtrace::force_capture().to_string());
            tracing::error!(target: "eos::panic", thread = thread.name().unwrap_or("unnamed"), %location, backtrace, "a thread panicked: {message}");
            crate::flush(Duration::from_millis(500));
            IN_HOOK.with(|h| h.set(false));
        }
        previous(info);
    }));
}

/// The app's own frames of a backtrace, innermost first, on one line: `function (file:line)`
/// joined by ` < `. Frames of the standard library and other crates are left out.
fn own_frames(backtrace: &str) -> String {
    let mut frames = Vec::new();
    let mut lines = backtrace.lines().map(str::trim).peekable();
    while let Some(line) = lines.next() {
        let Some((index, function)) = line.split_once(": ") else { continue };
        if index.parse::<usize>().is_err() {
            continue;
        }
        let at = lines.next_if(|next| next.starts_with("at ")).map(|at| at.trim_start_matches("at "));
        if !function.starts_with("eos") {
            continue;
        }
        let file = at.map(|at| at.rsplit_once("/src/").map_or(at, |(_, rest)| rest));
        frames.push(match file {
            Some(file) => format!("{function} ({file})"),
            None => function.to_owned(),
        });
        if frames.len() == FRAMES {
            break;
        }
    }
    frames.join(" < ")
}

#[cfg(test)]
mod tests {
    use super::own_frames;

    #[test]
    fn a_backtrace_keeps_the_apps_own_frames_on_one_line() {
        let trace = "   0: std::backtrace::Backtrace::force_capture
             at /rustc/abc/library/std/src/backtrace.rs:312:9
   1: eos_kit_log::panic::catch_panics::{{closure}}
             at /Users/u/eos/crates/eos-kit-log/src/panic.rs:29:30
   2: core::ops::function::Fn::call
   3: eos_sessions::service::Sessions::record
             at /Users/u/eos/crates/eos-sessions/src/service.rs:350:5
   4: tokio::runtime::task::harness::poll
";
        assert_eq!(
            own_frames(trace),
            "eos_kit_log::panic::catch_panics::{{closure}} (panic.rs:29:30) < eos_sessions::service::Sessions::record (service.rs:350:5)"
        );
    }
}
