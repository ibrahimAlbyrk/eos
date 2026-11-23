//! Code-view panes: a pane's conversation is read from its transcript once
//! it has been quiet for a minute, and at once when the pane exits; without
//! panes nothing is polled.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::PtyConversationRow;
use eos_domain::claude_transcript::TranscriptView;
use eos_mod_memory::{CodeParts, MemoryModule};
use eos_runtime::bus::{Bus, BusOptions};
use eos_runtime::module::Module;
use eos_runtime::ordered::Ordered;
use eos_testkit::{FakeClock, FakeSleeper, FakeTranscripts, TempStore};
use serde_json::{Value, json};

struct Panes {
    temp: TempStore,
    bus: Bus,
    clock: Arc<FakeClock>,
    sleeper: Arc<FakeSleeper>,
    transcripts: Arc<FakeTranscripts>,
    memory: MemoryModule,
}

impl Panes {
    async fn start() -> Self {
        let temp = TempStore::new();
        let clock = Arc::new(FakeClock::new());
        let bus = Bus::new(Ordered::new(), clock.clone(), BusOptions::default());
        let sleeper = Arc::new(FakeSleeper::default());
        let transcripts = Arc::new(FakeTranscripts::new());
        let mut parts = crate::rig::parts(&temp, sleeper.clone(), None);
        parts.clock = clock.clone();
        parts.code = Some(CodeParts { bus: bus.clone(), transcripts: transcripts.clone() });
        let memory = MemoryModule::new(parts);
        memory.start().await.unwrap();
        Self { temp, bus, clock, sleeper, transcripts, memory }
    }

    async fn publish(&self, topic: &'static str, payload: Value) {
        self.bus.publish_raw(topic, None, payload.to_string().into_bytes().into());
        self.bus.flush().await;
    }

    async fn open_pane(&self) {
        let session = json!({"sessionId": "pty1", "number": 1, "cwd": "/repo", "cols": 80, "rows": 24, "alive": true,
            "kind": "claude", "claudeSessionId": "c-1", "title": null, "remote": false, "owner": null});
        self.publish("pty:session", session).await;
    }

    fn write_correction(&self) {
        let row = |id: i64, kind: &str, payload: Value| PtyConversationRow {
            id,
            ts: (FakeClock::START_MS as f64).into(),
            r#type: kind.into(),
            payload: Some(payload),
        };
        let rows = vec![
            row(1, "user_message", json!({"text": "fix the build"})),
            row(
                2,
                "agent_event",
                json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": "Done."}]}),
            ),
            row(3, "user_message", json!({"text": "No, that's wrong"})),
        ];
        self.transcripts.set("/repo", "c-1", TranscriptView { rows, running: false, pending: None });
    }

    async fn moments(&self, want: i64) -> i64 {
        for _ in 0..200 {
            let got =
                self.temp.count("SELECT COUNT(*) FROM mem_moments WHERE source = 'code' AND worker_id = 'pty:c-1'");
            if got >= want {
                return got;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.temp.count("SELECT COUNT(*) FROM mem_moments")
    }
}

#[tokio::test]
async fn a_pane_that_exits_is_read_at_once() {
    let panes = Panes::start().await;
    panes.open_pane().await;
    panes.write_correction();
    panes.publish("pty:exit", json!({"sessionId": "pty1", "number": 1, "exitCode": 0})).await;
    assert_eq!(panes.moments(1).await, 1);
    panes.memory.stop().await;
}

#[tokio::test]
async fn a_pane_is_read_only_after_its_transcript_was_quiet_for_a_minute() {
    let panes = Panes::start().await;
    panes.open_pane().await;
    panes.write_correction();
    // The poll's first look sees the change, so the minute starts.
    panes.poll_once_and_go_on().await;
    assert_eq!(panes.temp.count("SELECT COUNT(*) FROM mem_moments"), 0, "still writing");
    panes.clock.advance(60_000);
    panes.poll_once_and_go_on().await;
    assert_eq!(panes.moments(1).await, 1);
    panes.memory.stop().await;
}

#[tokio::test]
async fn without_panes_nothing_is_polled_until_one_comes() {
    let panes = Panes::start().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!panes.sleeper.pending().contains(&15_000), "an idle app is not woken for nothing");
    panes.open_pane().await;
    panes.write_correction();
    panes.poll_once_and_go_on().await;
    panes.clock.advance(60_000);
    panes.poll_once_and_go_on().await;
    assert_eq!(panes.moments(1).await, 1);
    panes.memory.stop().await;
}

impl Panes {
    /// Ends the poll's wait and lets its look finish.
    async fn poll_once_and_go_on(&self) {
        for _ in 0..200 {
            if self.sleeper.pending().contains(&15_000) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let at = self.sleeper.pending().iter().position(|ms| *ms == 15_000).unwrap();
        // The oldest wait ends first: end the tick's too when it is older.
        for _ in 0..=at {
            assert!(self.sleeper.wake());
        }
        // The look runs until the poll waits again.
        for _ in 0..200 {
            if self.sleeper.pending().contains(&15_000) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}
