//! Shell → page events. The bridge script holds one `EventSource` on `/_shell/events`;
//! every event is one frame, fanned out by name in the page.

use std::sync::Mutex;

use serde_json::{Value, json};

use crate::transport::{Head, Offer, Sink};

/// The dashboard, and the same dashboard reloading: more than a few open streams means
/// something else is subscribing.
const MAX_SUBSCRIBERS: usize = 4;
/// Events emitted while no page listens (a link that launched the app, a banner clicked
/// before the dashboard loaded) wait for the first stream; beyond this the oldest is dropped.
const MAX_WAITING: usize = 16;

#[derive(Debug, Default)]
struct State {
    sinks: Vec<Sink>,
    waiting: std::collections::VecDeque<String>,
}

#[derive(Debug, Default)]
pub struct Events {
    state: Mutex<State>,
}

impl Events {
    /// Starts the stream on `sink`, beginning with the events that were waiting for a
    /// listener. Past the limit the oldest subscriber is ended.
    pub fn subscribe(&self, sink: Sink) {
        sink.head(Head {
            status: 200,
            headers: vec![
                ("content-type".into(), "text/event-stream".into()),
                ("cache-control".into(), "no-cache".into()),
            ],
        });
        sink.chunk(b": connected\n\n");
        let mut state = self.lock();
        for frame in state.waiting.drain(..) {
            sink.chunk(frame.as_bytes());
        }
        state.sinks.retain(|s| !s.is_cancelled());
        while state.sinks.len() >= MAX_SUBSCRIBERS {
            state.sinks.remove(0).end();
        }
        state.sinks.push(sink);
    }

    /// Sends one event to every subscriber. A subscriber that stopped reading is ended (its
    /// `EventSource` reconnects); one that went away is forgotten. With nobody listening the
    /// event is dropped: right for a command that only means something now (an Edit-menu
    /// command must not run after a reload).
    pub fn emit(&self, name: &str, payload: Value) {
        self.send(name, payload, false);
    }

    /// [`Events::emit`] for an event that is still wanted later: with nobody listening it
    /// waits for the next subscriber.
    pub fn emit_or_wait(&self, name: &str, payload: Value) {
        self.send(name, payload, true);
    }

    fn send(&self, name: &str, payload: Value, wait: bool) {
        let frame = format!("data: {}\n\n", json!({ "name": name, "payload": payload }));
        let mut state = self.lock();
        state.sinks.retain(|sink| match sink.offer(frame.as_bytes()) {
            Offer::Sent => true,
            Offer::Full => {
                sink.end();
                false
            }
            Offer::Gone => false,
        });
        if wait && state.sinks.is_empty() {
            if state.waiting.len() >= MAX_WAITING {
                state.waiting.pop_front();
            }
            state.waiting.push_back(frame);
        }
    }

    pub fn subscribers(&self) -> usize {
        self.lock().sinks.iter().filter(|s| !s.is_cancelled()).count()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{Body, HIGH_WATER, Read, channel};

    fn drain(body: &Body) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while let Read::Data(n) = body.read(&mut buf, || {}) {
            out.extend_from_slice(&buf[..n]);
        }
        String::from_utf8(out).expect("utf-8")
    }

    #[test]
    fn every_subscriber_gets_each_event_as_one_frame() {
        let events = Events::default();
        let (a, body_a) = channel();
        let (b, body_b) = channel();
        events.subscribe(a);
        events.subscribe(b);
        assert_eq!(
            body_a.head().map(|h| h.header("content-type").map(str::to_string)),
            Some(Some("text/event-stream".into()))
        );
        events.emit("window:fullscreen", json!({ "on": true }));
        for body in [&body_a, &body_b] {
            assert_eq!(
                drain(body),
                ": connected\n\ndata: {\"name\":\"window:fullscreen\",\"payload\":{\"on\":true}}\n\n"
            );
        }
    }

    #[test]
    fn a_closed_stream_is_forgotten() {
        let events = Events::default();
        let (a, body_a) = channel();
        let (b, _body_b) = channel();
        events.subscribe(a);
        events.subscribe(b);
        body_a.cancel();
        events.emit("x", Value::Null);
        assert_eq!(events.subscribers(), 1);
    }

    #[test]
    fn a_reader_that_fell_behind_is_ended_not_buffered() {
        let events = Events::default();
        let (a, body) = channel();
        events.subscribe(a);
        let big = "x".repeat(HIGH_WATER);
        events.emit("big", json!(big));
        events.emit("after", Value::Null);
        assert_eq!(events.subscribers(), 0);
        let text = drain(&body);
        assert!(!text.contains("\"after\""));
        assert_eq!(body.read(&mut [0u8; 8], || {}), Read::End);
    }

    #[test]
    fn an_event_with_no_listener_waits_for_the_first_stream() {
        let events = Events::default();
        events.emit_or_wait("hosts:command", json!({ "type": "connect" }));
        // A command for now is not kept.
        events.emit("edit", json!({ "command": "paste" }));
        for i in 0..MAX_WAITING + 3 {
            events.emit_or_wait("n", json!(i));
        }
        let (a, body) = channel();
        events.subscribe(a);
        let text = drain(&body);
        assert!(!text.contains("hosts:command"), "the oldest gave way");
        assert!(!text.contains("\"edit\""));
        assert!(text.contains(&format!("{{\"name\":\"n\",\"payload\":{}}}", MAX_WAITING + 2)));
        assert_eq!(text.matches("data: ").count(), MAX_WAITING);
        // Delivered once: the next stream starts clean.
        let (b, body_b) = channel();
        events.subscribe(b);
        assert_eq!(drain(&body_b), ": connected\n\n");
    }

    #[test]
    fn the_oldest_stream_gives_way_past_the_limit() {
        let events = Events::default();
        let mut bodies = Vec::new();
        for _ in 0..MAX_SUBSCRIBERS + 1 {
            let (sink, body) = channel();
            events.subscribe(sink);
            bodies.push(body);
        }
        assert_eq!(events.subscribers(), MAX_SUBSCRIBERS);
        drain(&bodies[0]);
        assert_eq!(bodies[0].read(&mut [0u8; 8], || {}), Read::End);
    }
}
