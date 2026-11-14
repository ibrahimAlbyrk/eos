//! The memory of in-flight streaming text. `agent:delta` events are
//! increments with no offset, so a client that missed some (a pane that just
//! came into view, a phone resuming) would render a hole. This keeps each
//! streaming block's text so far, for whoever needs to seed a live buffer.

use std::sync::{Arc, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::Value;

use crate::bus::{Bus, Subscription};
use eos_contracts::stream::topics;
use eos_core::Clock;

/// A stopped block stays a while: its durable row lands only when the whole
/// message ends, and a client resuming in between still needs the text. Past
/// this the row has landed, and an idle worker's blocks would only bloat
/// every snapshot.
pub const STOPPED_BLOCK_TTL_MS: i64 = 120_000;
const MAX_BLOCKS_PER_WORKER: usize = 6;

pub use eos_contracts::{LiveBlock, LiveBlockChannel as LiveChannel};

struct Tracked {
    block_id: String,
    channel: LiveChannel,
    text: String,
    stopped_at: Option<i64>,
}

/// Workers in the order their first block arrived (the snapshot's order).
type Workers = Vec<(String, Vec<Tracked>)>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delta {
    #[serde(default)]
    worker_id: Value,
    #[serde(default)]
    block_id: Value,
    #[serde(default)]
    channel: Value,
    #[serde(default)]
    phase: Value,
    #[serde(default)]
    text: Value,
}

#[derive(Clone)]
pub struct LiveText {
    workers: Arc<Mutex<Workers>>,
    clock: Arc<dyn Clock>,
    _subscriptions: Arc<[Subscription; 3]>,
}

impl std::fmt::Debug for LiveText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveText").field("workers", &lock(&self.workers).len()).finish_non_exhaustive()
    }
}

// Each update leaves the list valid, so a poisoned lock is safe to use.
fn lock(workers: &Mutex<Workers>) -> MutexGuard<'_, Workers> {
    workers.lock().unwrap_or_else(|p| p.into_inner())
}

impl LiveText {
    /// Starts following `agent:delta`; a worker's blocks are dropped when it
    /// exits or is removed.
    pub fn new(bus: &Bus) -> Self {
        let workers = Arc::new(Mutex::new(Workers::new()));
        let clock = bus.clock().clone();
        let (state, now) = (workers.clone(), clock.clone());
        let deltas = bus.on(topics::AGENT_DELTA, move |ev| {
            if let Ok(delta) = ev.payload_as::<Delta>() {
                on_delta(&mut lock(&state), delta, now.now_ms());
            }
        });
        let forget = |topic: &'static str| {
            let state = workers.clone();
            bus.on(topic, move |ev| {
                if let Ok(Value::Object(payload)) = ev.payload_as::<Value>()
                    && let Some(Value::String(id)) = payload.get("workerId")
                {
                    lock(&state).retain(|(worker, _)| worker != id);
                }
            })
        };
        let subscriptions = [deltas, forget(topics::WORKER_EXIT), forget(topics::WORKER_REMOVED)];
        Self { workers, clock, _subscriptions: Arc::new(subscriptions) }
    }

    /// Every worker's live blocks.
    pub fn snapshot(&self) -> Vec<LiveBlock> {
        let mut workers = lock(&self.workers);
        let cutoff = self.cutoff();
        let mut out = Vec::new();
        workers.retain_mut(|(worker, blocks)| {
            blocks.retain(|b| b.stopped_at.is_none_or(|at| at > cutoff));
            out.extend(blocks.iter().map(|b| block_of(worker, b)));
            !blocks.is_empty()
        });
        out
    }

    /// One worker's live blocks, oldest first. Hands out copies: later deltas
    /// do not change them.
    pub fn blocks_for(&self, worker_id: &str) -> Vec<LiveBlock> {
        let mut workers = lock(&self.workers);
        let cutoff = self.cutoff();
        let Some(i) = workers.iter().position(|(worker, _)| worker == worker_id) else { return Vec::new() };
        workers[i].1.retain(|b| b.stopped_at.is_none_or(|at| at > cutoff));
        if workers[i].1.is_empty() {
            workers.remove(i);
            return Vec::new();
        }
        workers[i].1.iter().map(|b| block_of(worker_id, b)).collect()
    }

    fn cutoff(&self) -> i64 {
        self.clock.now_ms().saturating_sub(STOPPED_BLOCK_TTL_MS)
    }
}

fn block_of(worker: &str, b: &Tracked) -> LiveBlock {
    LiveBlock {
        worker_id: worker.to_owned(),
        block_id: b.block_id.clone(),
        channel: b.channel,
        text: b.text.clone(),
        done: b.stopped_at.map(|_| true),
    }
}

fn on_delta(workers: &mut Workers, delta: Delta, now: i64) {
    let (Value::String(worker_id), Value::String(block_id)) = (delta.worker_id, delta.block_id) else { return };
    let text = match delta.text {
        Value::String(text) => text,
        _ => String::new(),
    };
    let channel = if delta.channel == "text" { LiveChannel::Text } else { LiveChannel::Reasoning };
    let phase = delta.phase.as_str().unwrap_or("");
    let at = workers.iter().position(|(worker, _)| *worker == worker_id);
    if let Some(block) = at.and_then(|i| workers[i].1.iter_mut().find(|b| b.block_id == block_id)) {
        match phase {
            "start" => {
                block.channel = channel;
                block.text = text;
                block.stopped_at = None;
            }
            "append" => block.text.push_str(&text),
            "stop" => block.stopped_at = Some(now),
            _ => {}
        }
        return;
    }
    if phase == "stop" {
        return;
    }
    // An append with no start seen (following began mid-stream) still seeds a
    // block: partial text beats none.
    let blocks = match at {
        Some(i) => &mut workers[i].1,
        None => {
            workers.push((worker_id, Vec::new()));
            // Just pushed.
            let last = workers.len() - 1;
            &mut workers[last].1
        }
    };
    blocks.push(Tracked { block_id, channel, text, stopped_at: None });
    if blocks.len() > MAX_BLOCKS_PER_WORKER {
        blocks.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::BusOptions;
    use crate::ordered::Ordered;
    use bytes::Bytes;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct TestClock(AtomicI64);
    impl Clock for TestClock {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct Harness {
        bus: Bus,
        live: LiveText,
        clock: Arc<TestClock>,
    }

    fn harness() -> Harness {
        let clock = Arc::new(TestClock(AtomicI64::new(1_000)));
        let bus = Bus::new(Ordered::new(), clock.clone(), BusOptions { delta_window: None });
        let live = LiveText::new(&bus);
        Harness { bus, live, clock }
    }

    impl Harness {
        fn delta(&self, worker: &str, block: &str, phase: &str, text: &str, channel: &str) {
            let payload = serde_json::json!({ "workerId": worker, "channel": channel, "phase": phase, "blockId": block, "text": text });
            self.bus.publish_raw(topics::AGENT_DELTA, None, Bytes::from(payload.to_string()));
        }
        fn text(&self, worker: &str, block: &str, phase: &str, text: &str) {
            self.delta(worker, block, phase, text, "text");
        }
        async fn snapshot(&self) -> Vec<LiveBlock> {
            self.bus.flush().await;
            self.live.snapshot()
        }
    }

    fn block(worker: &str, id: &str, channel: LiveChannel, text: &str, done: Option<bool>) -> LiveBlock {
        LiveBlock { worker_id: worker.into(), block_id: id.into(), channel, text: text.into(), done }
    }

    #[tokio::test]
    async fn accumulates_start_and_appends_and_keeps_the_block_through_stop() {
        let h = harness();
        h.text("w1", "b1", "start", "Hel");
        h.text("w1", "b1", "append", "lo");
        h.text("w1", "b1", "stop", "");
        h.delta("w1", "b2", "start", "think", "reasoning");
        assert_eq!(
            h.snapshot().await,
            [
                block("w1", "b1", LiveChannel::Text, "Hello", Some(true)),
                block("w1", "b2", LiveChannel::Reasoning, "think", None),
            ]
        );
        let json = serde_json::to_string(&h.live.snapshot()).expect("serializes");
        assert_eq!(
            json,
            r#"[{"workerId":"w1","blockId":"b1","channel":"text","text":"Hello","done":true},{"workerId":"w1","blockId":"b2","channel":"reasoning","text":"think"}]"#
        );
    }

    #[tokio::test]
    async fn blocks_for_returns_one_workers_blocks() {
        let h = harness();
        h.text("w1", "b1", "start", "a");
        h.text("w2", "b2", "start", "b");
        h.bus.flush().await;
        assert_eq!(h.live.blocks_for("w2"), [block("w2", "b2", LiveChannel::Text, "b", None)]);
        assert_eq!(h.live.blocks_for("nobody"), []);
    }

    #[tokio::test]
    async fn seeds_from_an_append_with_no_start_and_ignores_a_stop_for_an_unknown_block() {
        let h = harness();
        h.text("w1", "b1", "append", "mid-");
        h.text("w1", "b1", "append", "stream");
        h.text("w1", "b9", "stop", "");
        let snap = h.snapshot().await;
        assert_eq!(
            snap.iter().map(|b| (b.block_id.as_str(), b.text.as_str())).collect::<Vec<_>>(),
            [("b1", "mid-stream")]
        );
    }

    #[tokio::test]
    async fn caps_each_worker_at_the_six_most_recent_blocks() {
        let h = harness();
        for i in 1..=8 {
            h.text("w1", &format!("b{i}"), "start", &i.to_string());
        }
        let ids: Vec<String> = h.snapshot().await.into_iter().map(|b| b.block_id).collect();
        assert_eq!(ids, ["b3", "b4", "b5", "b6", "b7", "b8"]);
    }

    #[tokio::test]
    async fn drops_a_workers_blocks_when_it_exits_or_is_removed() {
        let h = harness();
        h.text("w1", "b1", "start", "a");
        h.text("w2", "b2", "start", "b");
        h.text("w3", "b3", "start", "c");
        h.bus.publish_raw(topics::WORKER_EXIT, None, Bytes::from_static(br#"{"workerId":"w1","code":0}"#));
        h.bus.publish_raw(topics::WORKER_REMOVED, None, Bytes::from_static(br#"{"workerId":"w2"}"#));
        let workers: Vec<String> = h.snapshot().await.into_iter().map(|b| b.worker_id).collect();
        assert_eq!(workers, ["w3"]);
    }

    #[tokio::test]
    async fn hands_out_copies() {
        let h = harness();
        h.text("w1", "b1", "start", "a");
        let snap = h.snapshot().await;
        h.text("w1", "b1", "append", "b");
        h.bus.flush().await;
        assert_eq!(snap[0].text, "a");
        assert_eq!(h.live.snapshot()[0].text, "ab");
    }

    #[tokio::test]
    async fn forgets_a_stopped_block_after_the_ttl_and_keeps_a_streaming_one() {
        let h = harness();
        h.text("w1", "b1", "start", "done");
        h.text("w1", "b1", "stop", "");
        h.text("w2", "b2", "start", "still going");
        h.bus.flush().await;
        h.clock.0.fetch_add(STOPPED_BLOCK_TTL_MS - 1, Ordering::SeqCst);
        assert_eq!(h.live.snapshot().iter().map(|b| b.block_id.as_str()).collect::<Vec<_>>(), ["b1", "b2"]);
        h.clock.0.fetch_add(2, Ordering::SeqCst);
        assert_eq!(h.live.snapshot().iter().map(|b| b.block_id.as_str()).collect::<Vec<_>>(), ["b2"]);
    }

    #[tokio::test]
    async fn a_restart_resets_the_text_and_odd_payloads_are_ignored() {
        let h = harness();
        h.text("w1", "b1", "start", "old");
        h.text("w1", "b1", "stop", "");
        h.delta("w1", "b1", "start", "new", "reasoning");
        h.bus.publish_raw(
            topics::AGENT_DELTA,
            None,
            Bytes::from_static(br#"{"workerId":5,"blockId":"x","phase":"start","text":"n"}"#),
        );
        h.bus.publish_raw(topics::AGENT_DELTA, None, Bytes::from_static(b"null"));
        assert_eq!(h.snapshot().await, [block("w1", "b1", LiveChannel::Reasoning, "new", None)]);
    }
}
