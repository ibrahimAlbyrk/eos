//! Shell → page events. Each document of the dashboard holds one `EventSource` on
//! `/_shell/events`, named by its surface (`?surface=quick` for the quick panel); every event
//! is one frame, fanned out by name in the page. A surface hears only its own events.

use std::sync::Mutex;

use serde_json::{Value, json};

use crate::transport::{Head, Offer, Sink};

/// The dashboard, and the same dashboard reloading: more than a few open streams means
/// something else is subscribing.
const MAX_SUBSCRIBERS: usize = 4;
/// Events emitted while no page listens (a link that launched the app, a banner clicked
/// before the dashboard loaded) wait for the first stream; beyond this the oldest is dropped.
const MAX_WAITING: usize = 16;

/// Which document of the dashboard listens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// The window's dashboard.
    Dashboard,
    /// The quick panel (07 §4.3).
    Quick,
}

impl Surface {
    /// The `surface` query parameter: none is the dashboard; an unknown name is no surface.
    pub fn parse(name: Option<&str>) -> Option<Self> {
        match name {
            None | Some("") => Some(Surface::Dashboard),
            Some("quick") => Some(Surface::Quick),
            Some(_) => None,
        }
    }
}

#[derive(Debug, Default)]
struct State {
    sinks: Vec<Sink>,
    waiting: std::collections::VecDeque<String>,
}

#[derive(Debug, Default)]
pub struct Events {
    dashboard: Mutex<State>,
    quick: Mutex<State>,
}

impl Events {
    /// Starts the dashboard's stream on `sink`.
    pub fn subscribe(&self, sink: Sink) {
        self.subscribe_to(Surface::Dashboard, sink);
    }

    /// Starts a surface's stream on `sink`, beginning with the events that were waiting for a
    /// listener. Past the limit the oldest subscriber is ended.
    pub fn subscribe_to(&self, surface: Surface, sink: Sink) {
        sink.head(Head {
            status: 200,
            headers: vec![
                ("content-type".into(), "text/event-stream".into()),
                ("cache-control".into(), "no-cache".into()),
            ],
        });
        sink.chunk(b": connected\n\n");
        let mut state = self.lock(surface);
        for frame in state.waiting.drain(..) {
            sink.chunk(frame.as_bytes());
        }
        state.sinks.retain(|s| !s.is_cancelled());
        while state.sinks.len() >= MAX_SUBSCRIBERS {
            state.sinks.remove(0).end();
        }
        state.sinks.push(sink);
    }

    /// Sends one event to every subscriber of the dashboard. A subscriber that stopped reading
    /// is ended (its `EventSource` reconnects); one that went away is forgotten. With nobody
    /// listening the event is dropped: right for a command that only means something now (an
    /// Edit-menu command must not run after a reload).
    pub fn emit(&self, name: &str, payload: Value) {
        self.send(Surface::Dashboard, name, payload, false);
    }

    /// [`Events::emit`] for an event that is still wanted later: with nobody listening it
    /// waits for the next subscriber.
    pub fn emit_or_wait(&self, name: &str, payload: Value) {
        self.send(Surface::Dashboard, name, payload, true);
    }

    /// [`Events::emit`] to another surface.
    pub fn emit_to(&self, surface: Surface, name: &str, payload: Value) {
        self.send(surface, name, payload, false);
    }

    fn send(&self, surface: Surface, name: &str, payload: Value, wait: bool) {
        let frame = format!("data: {}\n\n", json!({ "name": name, "payload": payload }));
        let mut state = self.lock(surface);
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

    /// The dashboard's open streams.
    pub fn subscribers(&self) -> usize {
        self.subscribers_of(Surface::Dashboard)
    }

    pub fn subscribers_of(&self, surface: Surface) -> usize {
        self.lock(surface).sinks.iter().filter(|s| !s.is_cancelled()).count()
    }

    fn lock(&self, surface: Surface) -> std::sync::MutexGuard<'_, State> {
        let state = match surface {
            Surface::Dashboard => &self.dashboard,
            Surface::Quick => &self.quick,
        };
        state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
    fn each_surface_hears_only_its_own_events() {
        let events = Events::default();
        let (dash, dash_body) = channel();
        let (quick, quick_body) = channel();
        events.subscribe(dash);
        events.subscribe_to(Surface::Quick, quick);
        events.emit("navigate", json!({ "route": "eos:/needs" }));
        events.emit_to(Surface::Quick, "doors:held", json!({ "source": "link" }));
        let (dash, quick) = (drain(&dash_body), drain(&quick_body));
        assert!(dash.contains("navigate") && !dash.contains("doors:held"));
        assert!(quick.contains("doors:held") && !quick.contains("navigate"));
        assert_eq!((events.subscribers(), events.subscribers_of(Surface::Quick)), (1, 1));
        assert_eq!(Surface::parse(None), Some(Surface::Dashboard));
        assert_eq!(Surface::parse(Some("quick")), Some(Surface::Quick));
        assert_eq!(Surface::parse(Some("other")), None);
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
