//! Live token deltas (`agent:delta`) arrive one per model chunk — dozens a
//! second per streaming block, each a frame on every stream with a couple of
//! hundred bytes around a few characters.
//!
//! A block's first delta passes straight through; the next ones are held for
//! the window and merged into one (text appended, every other field of the
//! first kept). Anything else published — a stop, another topic — first
//! releases what is held, so a block's deltas never trail the events after
//! them.

use std::collections::VecDeque;
use std::ops::Range;

use bytes::Bytes;
use serde::Deserialize;
use serde_json::value::RawValue;

use super::Event;
use eos_contracts::stream::topics::AGENT_DELTA;

/// The fields of a delta the coalescer reads, as their raw JSON text.
#[derive(Deserialize)]
struct RawDelta<'a> {
    #[serde(borrow, rename = "workerId")]
    worker_id: Option<&'a RawValue>,
    #[serde(borrow, rename = "blockId")]
    block_id: Option<&'a RawValue>,
    #[serde(borrow)]
    phase: Option<&'a RawValue>,
    #[serde(borrow)]
    text: Option<&'a RawValue>,
    #[serde(borrow)]
    channel: Option<&'a RawValue>,
}

fn string(raw: Option<&RawValue>) -> Option<&str> {
    raw.map(RawValue::get).filter(|s| s.starts_with('"'))
}

struct Held {
    first: Event,
    /// Where the `text` value sits in the first payload.
    text_at: Range<usize>,
    text: String,
    parts: u32,
    /// The raw `channel` value.
    channel: Option<Box<str>>,
}

impl Held {
    fn release(self, now: i64) -> Event {
        let mut ev = self.first;
        ev.ts = now;
        if self.parts > 1
            && let Ok(merged) = serde_json::to_string(&self.text)
        {
            // Splice the merged text into the first payload: every other
            // field, and the key order, stay exactly as published.
            let mut out = Vec::with_capacity(ev.payload.len() + merged.len());
            out.extend_from_slice(&ev.payload[..self.text_at.start]);
            out.extend_from_slice(merged.as_bytes());
            out.extend_from_slice(&ev.payload[self.text_at.end..]);
            ev.payload = Bytes::from(out);
        }
        ev
    }
}

struct Slot {
    /// Raw JSON of the ids: the same serializer wrote them, so equal ids are equal text.
    worker: Box<str>,
    block: Box<str>,
    generation: u64,
    held: Option<Held>,
}

/// Names one window of one block, so a timer armed for a replaced window does nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Window {
    worker: Box<str>,
    block: Box<str>,
    generation: u64,
}

/// The state machine; the bus owns the timers. Slots are kept in arrival
/// order because that is the order held text is released in.
#[derive(Default)]
pub(crate) struct Coalescer {
    slots: Vec<Slot>,
    generation: u64,
}

impl Coalescer {
    fn release_all(&mut self, now: i64, out: &mut VecDeque<Event>) {
        for slot in &mut self.slots {
            if let Some(held) = slot.held.take() {
                out.push_back(held.release(now));
            }
        }
    }

    fn position(&self, worker: &str, block: &str) -> Option<usize> {
        self.slots.iter().position(|s| s.worker.as_ref() == worker && s.block.as_ref() == block)
    }

    /// Takes one published event; pushes what goes out now, in order. Returns
    /// a window to time when the event opened one.
    pub(crate) fn offer(&mut self, ev: Event, now: i64, out: &mut VecDeque<Event>) -> Option<Window> {
        if ev.topic.as_str() != AGENT_DELTA {
            self.release_all(now, out);
            out.push_back(ev);
            return None;
        }
        let payload = ev.payload.clone();
        let parsed = std::str::from_utf8(&payload).ok().and_then(|text| {
            let raw: RawDelta<'_> = serde_json::from_str(text).ok()?;
            Some((text, raw))
        });
        let ids = parsed.as_ref().and_then(|(_, raw)| Some((string(raw.worker_id)?, string(raw.block_id)?)));
        let delta = parsed.as_ref().zip(ids).and_then(|((source, raw), (worker, block))| {
            let phase = raw.phase.map(RawValue::get)?;
            let text = string(raw.text)?;
            let start = phase == "\"start\"";
            if !start && phase != "\"append\"" {
                return None;
            }
            let at = text.as_ptr() as usize - source.as_ptr() as usize;
            Some((worker, block, start, text, at..at + text.len(), raw.channel.map(RawValue::get)))
        });

        let Some((worker, block, start, text, text_at, channel)) = delta else {
            // A stop, or a delta of an unknown shape: nothing may trail it.
            self.release_all(now, out);
            if let Some((worker, block)) = ids
                && let Some(i) = self.position(worker, block)
            {
                self.slots.remove(i);
            }
            out.push_back(ev);
            return None;
        };

        let existing = self.position(worker, block);
        let Some(i) = existing.filter(|_| !start) else {
            // A block's first delta, or a restart: it resets the block's text,
            // so it cannot fold into held appends.
            if existing.is_some() {
                self.release_all(now, out);
            }
            self.generation += 1;
            let slot = Slot { worker: worker.into(), block: block.into(), generation: self.generation, held: None };
            let window = Window { worker: slot.worker.clone(), block: slot.block.clone(), generation: slot.generation };
            match existing {
                Some(i) => self.slots[i] = slot,
                None => self.slots.push(slot),
            }
            out.push_back(ev);
            return Some(window);
        };

        let slot = &mut self.slots[i];
        if slot.held.as_ref().is_some_and(|h| h.channel.as_deref() != channel)
            && let Some(held) = slot.held.take()
        {
            out.push_back(held.release(now));
        }
        let piece: String = serde_json::from_str(text).unwrap_or_default();
        match &mut slot.held {
            Some(held) => {
                held.text.push_str(&piece);
                held.parts += 1;
            }
            None => {
                slot.held = Some(Held { first: ev, text_at, text: piece, parts: 1, channel: channel.map(Into::into) })
            }
        }
        None
    }

    /// A window's time is up: send what piled up. `true` keeps the window open
    /// (the block is still streaming); `false` means it is gone.
    pub(crate) fn window_closed(&mut self, window: &Window, now: i64, out: &mut VecDeque<Event>) -> bool {
        let Some(i) = self.position(&window.worker, &window.block) else { return false };
        if self.slots[i].generation != window.generation {
            return false;
        }
        match self.slots[i].held.take() {
            Some(held) => {
                out.push_back(held.release(now));
                true
            }
            None => {
                self.slots.remove(i);
                false
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn open_windows(&self) -> usize {
        self.slots.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::TopicName;

    fn event(topic: &'static str, payload: &str) -> Event {
        Event {
            topic: TopicName::Static(topic),
            payload: Bytes::copy_from_slice(payload.as_bytes()),
            scope: None,
            ts: 0,
        }
    }

    fn delta(block: &str, phase: &str, text: &str, at: u32, worker: &str) -> Event {
        let payload = format!(
            r#"{{"workerId":"{worker}","channel":"text","phase":"{phase}","blockId":"{block}","text":{},"at":{at}}}"#,
            serde_json::to_string(text).expect("string")
        );
        event(AGENT_DELTA, &payload)
    }

    struct Harness {
        c: Coalescer,
        out: VecDeque<Event>,
        windows: Vec<Window>,
    }

    impl Harness {
        fn new() -> Self {
            Self { c: Coalescer::default(), out: VecDeque::new(), windows: Vec::new() }
        }
        fn offer(&mut self, ev: Event) {
            if let Some(w) = self.c.offer(ev, 7, &mut self.out) {
                self.windows.push(w);
            }
        }
        fn close_all(&mut self) {
            let windows = std::mem::take(&mut self.windows);
            for w in windows {
                if self.c.window_closed(&w, 9, &mut self.out) {
                    self.windows.push(w);
                }
            }
        }
        fn texts(&self) -> Vec<String> {
            self.out
                .iter()
                .filter(|e| e.topic.as_str() == AGENT_DELTA)
                .map(|e| {
                    let v: serde_json::Value = serde_json::from_slice(&e.payload).expect("json");
                    v["text"].as_str().unwrap_or("").to_owned()
                })
                .collect()
        }
    }

    #[test]
    fn sends_a_blocks_first_delta_at_once_and_merges_the_rest_of_each_window() {
        let mut h = Harness::new();
        h.offer(delta("b", "start", "He", 0, "w1"));
        h.offer(delta("b", "append", "l", 2, "w1"));
        h.offer(delta("b", "append", "lo", 3, "w1"));
        assert_eq!(h.texts(), ["He"], "the first token is not delayed");
        h.close_all();
        assert_eq!(h.texts(), ["He", "llo"]);
        // The merged delta starts where its first part did: every field but
        // the text is the first part's, in the order it was published.
        assert_eq!(
            h.out[1].payload.as_ref(),
            br#"{"workerId":"w1","channel":"text","phase":"append","blockId":"b","text":"llo","at":2}"#
        );
        assert_eq!(h.out[1].ts, 9, "stamped when it goes out");
    }

    #[test]
    fn releases_held_text_before_any_other_event_so_nothing_trails_what_follows_it() {
        let mut h = Harness::new();
        h.offer(delta("b", "start", "a", 0, "w1"));
        h.offer(delta("b", "append", "b", 1, "w1"));
        h.offer(event("worker:change", r#"{"workerId":"w1"}"#));
        h.offer(delta("b", "stop", "", 2, "w1"));
        let seen: Vec<String> = h
            .out
            .iter()
            .map(|e| {
                let v: serde_json::Value = serde_json::from_slice(&e.payload).expect("json");
                format!("{}:{}", e.topic, v["text"].as_str().unwrap_or(""))
            })
            .collect();
        assert_eq!(seen, ["agent:delta:a", "agent:delta:b", "worker:change:", "agent:delta:"]);
        assert_eq!(h.c.open_windows(), 0, "a stop closes the block's window");
    }

    #[test]
    fn keeps_blocks_apart_and_lets_a_restart_through_at_once() {
        let mut h = Harness::new();
        h.offer(delta("x", "start", "1", 0, "w1"));
        h.offer(delta("y", "start", "A", 0, "w2"));
        h.offer(delta("x", "append", "2", 1, "w1"));
        h.offer(delta("y", "append", "B", 1, "w2"));
        h.offer(delta("x", "start", "new", 0, "w1"));
        assert_eq!(h.texts(), ["1", "A", "2", "B", "new"], "a restart releases held text first");
        h.offer(delta("y", "append", "C", 2, "w2"));
        h.close_all();
        assert_eq!(h.texts(), ["1", "A", "2", "B", "new", "C"]);
    }

    #[test]
    fn a_single_held_delta_goes_out_untouched_and_an_idle_window_goes_away() {
        let mut h = Harness::new();
        h.offer(delta("b", "start", "a", 0, "w1"));
        let held = delta("b", "append", "é\n\"q\"", 1, "w1");
        let held_bytes = held.payload.clone();
        h.offer(held);
        h.close_all();
        assert_eq!(h.out[1].payload, held_bytes);
        assert_eq!(h.c.open_windows(), 1, "the block is still streaming");
        h.close_all();
        assert_eq!(h.c.open_windows(), 0, "nothing arrived for a whole window");
        assert!(h.windows.is_empty());
    }

    #[test]
    fn a_timer_of_a_replaced_window_does_nothing() {
        let mut h = Harness::new();
        h.offer(delta("b", "start", "a", 0, "w1"));
        let stale = h.windows.remove(0);
        h.offer(delta("b", "start", "again", 0, "w1"));
        h.offer(delta("b", "append", "x", 1, "w1"));
        assert!(!h.c.window_closed(&stale, 9, &mut h.out));
        assert_eq!(h.texts(), ["a", "again"], "the held text waits for its own window");
    }

    #[test]
    fn does_not_merge_across_channels_and_passes_odd_shapes_through() {
        let mut h = Harness::new();
        h.offer(delta("b", "start", "t", 0, "w1"));
        h.offer(delta("b", "append", "one", 1, "w1"));
        h.offer(event(
            AGENT_DELTA,
            r#"{"workerId":"w1","channel":"reasoning","phase":"append","blockId":"b","text":"two"}"#,
        ));
        assert_eq!(h.texts(), ["t", "one"], "the other channel's text is released first");
        h.offer(event(AGENT_DELTA, r#"{"workerId":7,"phase":"append","blockId":"b","text":"odd"}"#));
        assert_eq!(h.texts(), ["t", "one", "two", "odd"]);
        h.offer(event(AGENT_DELTA, "null"));
        assert_eq!(h.out.len(), 5);
    }

    #[test]
    fn merges_escaped_text_correctly() {
        let mut h = Harness::new();
        h.offer(delta("b", "start", "", 0, "w1"));
        h.offer(delta("b", "append", "line\n", 1, "w1"));
        h.offer(delta("b", "append", "\"quoted\" ✓", 2, "w1"));
        h.close_all();
        assert_eq!(h.texts(), ["", "line\n\"quoted\" ✓"]);
    }
}
