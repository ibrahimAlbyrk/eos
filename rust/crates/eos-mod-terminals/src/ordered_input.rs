//! Writes each input stream's pieces in `seq` order
//! (`manager/services/pty/orderedInput.ts`).
//!
//! A client keeps several inputs in flight, and requests overtake each other
//! on the way (over a peer link each one is its own stream) — so a piece can
//! arrive before the one typed ahead of it. It waits for that one, but never
//! longer than [`HOLD`]: then what is held goes out in order and a straggler
//! is written when it lands. Losing a keystroke is worse than a late one.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use indexmap::IndexMap;

const HOLD: Duration = Duration::from_millis(1000);
/// Streams of closed tabs: dropped once this many others are newer.
const MAX_STREAMS: usize = 256;
/// Pieces one stream may hold back; past it the oldest go out without waiting.
const MAX_HELD: usize = 1024;

pub(crate) type Write = Arc<dyn Fn(&str) + Send + Sync>;

struct Stream {
    /// The next `seq` to write; they start at 1.
    next: u64,
    held: BTreeMap<u64, String>,
    /// Which armed timer is this stream's: an older one finds itself replaced.
    timer: Option<u64>,
}

#[derive(Default)]
struct State {
    /// Least recently used first.
    streams: IndexMap<String, Stream>,
    timers: u64,
}

#[derive(Clone, Default)]
pub(crate) struct OrderedInput {
    state: Arc<Mutex<State>>,
}

impl OrderedInput {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Takes piece `seq` of stream `key`. `write` is called, in order, for
    /// everything that may go out now; it must not block.
    pub(crate) fn accept(&self, key: &str, seq: u64, data: &str, write: Write) {
        let mut state = self.state();
        let mut stream =
            state.streams.shift_remove(key).unwrap_or(Stream { next: 1, held: BTreeMap::new(), timer: None });
        while state.streams.len() >= MAX_STREAMS {
            state.streams.shift_remove_index(0);
        }
        if seq < stream.next {
            // A straggler the stream stopped waiting for.
            write(data);
            state.streams.insert(key.to_owned(), stream);
            return;
        }
        stream.held.insert(seq, data.to_owned());
        while let Some(ready) = stream.held.remove(&stream.next) {
            write(&ready);
            stream.next += 1;
        }
        while stream.held.len() > MAX_HELD {
            if let Some((at, data)) = stream.held.pop_first() {
                write(&data);
                stream.next = at + 1;
            }
        }
        if stream.held.is_empty() {
            stream.timer = None;
        } else if stream.timer.is_none() {
            state.timers += 1;
            let timer = state.timers;
            stream.timer = Some(timer);
            let (this, key) = (self.clone(), key.to_owned());
            tokio::spawn(async move {
                tokio::time::sleep(HOLD).await;
                this.give_up_waiting(&key, timer, &write);
            });
        }
        state.streams.insert(key.to_owned(), stream);
    }

    fn give_up_waiting(&self, key: &str, timer: u64, write: &Write) {
        let mut state = self.state();
        let Some(stream) = state.streams.get_mut(key).filter(|s| s.timer == Some(timer)) else { return };
        stream.timer = None;
        while let Some((at, data)) = stream.held.pop_first() {
            write(&data);
            stream.next = at + 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorder() -> (Write, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        (Arc::new(move |data: &str| sink.lock().expect("log").push(data.to_owned())), log)
    }

    fn written(log: &Arc<Mutex<Vec<String>>>) -> String {
        log.lock().expect("log").concat()
    }

    #[tokio::test(start_paused = true)]
    async fn pieces_that_overtook_each_other_go_out_in_order() {
        let input = OrderedInput::default();
        let (write, log) = recorder();
        input.accept("tab", 2, "b", write.clone());
        input.accept("tab", 3, "c", write.clone());
        assert_eq!(written(&log), "", "waiting for the first");
        input.accept("tab", 1, "a", write.clone());
        assert_eq!(written(&log), "abc");
        input.accept("tab", 4, "d", write);
        assert_eq!(written(&log), "abcd");
    }

    #[tokio::test(start_paused = true)]
    async fn a_missing_piece_holds_the_rest_for_a_second_only() {
        let input = OrderedInput::default();
        let (write, log) = recorder();
        input.accept("tab", 2, "b", write.clone());
        input.accept("tab", 4, "d", write.clone());
        tokio::time::sleep(HOLD + Duration::from_millis(10)).await;
        assert_eq!(written(&log), "bd", "what was held went out in order");
        // The stragglers are written when they land, late rather than lost.
        input.accept("tab", 1, "a", write.clone());
        input.accept("tab", 5, "e", write);
        assert_eq!(written(&log), "bdae");
    }

    #[tokio::test(start_paused = true)]
    async fn streams_are_independent_and_old_ones_are_forgotten() {
        let input = OrderedInput::default();
        let (write, log) = recorder();
        input.accept("one", 2, "late", write.clone());
        input.accept("two", 1, "x", write.clone());
        assert_eq!(written(&log), "x");
        for i in 0..MAX_STREAMS {
            input.accept(&format!("other-{i}"), 1, "", write.clone());
        }
        assert!(!input.state().streams.contains_key("one"), "pushed out by newer streams");
        assert_eq!(input.state().streams.len(), MAX_STREAMS);
    }
}
