//! Announcing a database write under a declared topic.

use eos_core::store::Outbox;
use serde::Serialize;

use super::Topic;

/// `out.announce(&TOPIC, &payload)` inside a write job: the event goes out
/// once the write is saved, after every earlier write's events, and the
/// payload type is checked against the topic as [`Bus::publish`](super::Bus::publish)
/// checks it.
pub trait Announce {
    fn announce<T: Serialize>(&mut self, topic: &Topic<T>, payload: &T);
}

impl Announce for Outbox {
    fn announce<T: Serialize>(&mut self, topic: &Topic<T>, payload: &T) {
        // A scoped topic (live text, terminal output) never announces a row:
        // its scope would be lost on the way, so it is published directly.
        debug_assert!(topic.decl().scope.is_none(), "{} is a scoped topic: publish it on the bus", topic.name());
        self.push(topic.name(), payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_announcement_carries_the_topics_name_and_the_payload_as_json() {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Change {
            worker_id: &'static str,
        }
        const CHANGE: Topic<Change> = Topic::new("worker:change");
        let mut out = Outbox::default();
        out.announce(&CHANGE, &Change { worker_id: "w-1" });
        let events = out.into_events();
        assert_eq!(events[0].topic, "worker:change");
        assert_eq!(events[0].payload, br#"{"workerId":"w-1"}"#);
    }
}
