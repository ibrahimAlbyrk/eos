//! A measuring probe for responsiveness runs (`Options::probe`, `tests/responsiveness.py`):
//! DevTools calls on the dashboard, and a heartbeat on the UI thread that records each time
//! the thread was late to run it. Never part of a normal run.

use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri::Manager;

use crate::views::Views;

/// The heartbeat's period, and the lateness that counts as a stall (one frame at 60 Hz).
const BEAT: Duration = Duration::from_millis(4);
const STALL: Duration = Duration::from_millis(16);
/// Stalls kept until read; older ones are dropped.
const KEPT: usize = 512;

/// The dashboard's DevTools events, kept only while a probe runs (a trace's end).
static EVENTS: OnceLock<Mutex<VecDeque<(String, Value)>>> = OnceLock::new();
const EVENTS_KEPT: usize = 64;

/// The dashboard's DevTools event handler (main thread): kept for the probe, else dropped.
pub(crate) fn dashboard_event(method: &str, params: Value) {
    if let Some(events) = EVENTS.get() {
        let mut events = events.lock().unwrap_or_else(|p| p.into_inner());
        if events.len() == EVENTS_KEPT {
            events.pop_front();
        }
        events.push_back((method.to_owned(), params));
    }
}

#[derive(Default)]
struct Stalls {
    list: VecDeque<(u64, u64)>,
    beats: u64,
}

/// What a responsiveness run reaches in the shell.
pub struct Probe {
    views: Arc<Views>,
    stalls: Arc<Mutex<Stalls>>,
}

impl std::fmt::Debug for Probe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Probe").finish_non_exhaustive()
    }
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Probe {
    /// Starts the heartbeat: a thread that posts a task to the UI thread every few
    /// milliseconds and notes how late each one ran.
    pub(crate) fn start(app: tauri::AppHandle, views: Arc<Views>) -> Arc<Self> {
        let stalls: Arc<Mutex<Stalls>> = Arc::default();
        let beats = stalls.clone();
        let _ = std::thread::Builder::new().name("eos-probe".into()).spawn(move || {
            loop {
                let (sent_at, sent) = (SystemTime::now(), Instant::now());
                let (tx, rx) = std::sync::mpsc::sync_channel(1);
                if app
                    .run_on_main_thread(move || {
                        let _ = tx.send(Instant::now());
                    })
                    .is_err()
                {
                    return;
                }
                // A thread that does not answer for seconds is a stall too.
                let late = rx.recv_timeout(Duration::from_secs(5)).map_or(Duration::from_secs(5), |ran| ran - sent);
                let mut stalls = beats.lock().unwrap_or_else(|p| p.into_inner());
                stalls.beats += 1;
                if late > STALL {
                    if stalls.list.len() == KEPT {
                        stalls.list.pop_front();
                    }
                    stalls.list.push_back((epoch_ms(sent_at), late.as_millis() as u64));
                }
                drop(stalls);
                std::thread::sleep(BEAT);
            }
        });
        let _ = EVENTS.set(Mutex::default());
        Arc::new(Probe { views, stalls })
    }

    /// Starts a Chromium trace of every process (`categories`: Chromium's filter string).
    pub async fn trace_start(&self, categories: &str) -> Result<Value, String> {
        let config =
            json!({ "recordMode": "recordUntilFull", "includedCategories": categories.split(',').collect::<Vec<_>>() });
        self.dashboard("Tracing.start", json!({ "transferMode": "ReturnAsStream", "traceConfig": config })).await
    }

    /// Ends the trace and writes it to `file` (Chromium's JSON trace format).
    pub async fn trace_stop(&self, file: &Path) -> Result<Value, String> {
        self.dashboard("Tracing.end", json!({})).await?;
        let stream = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let done = EVENTS.get().and_then(|events| {
                    let mut events = events.lock().unwrap_or_else(|p| p.into_inner());
                    let at = events.iter().position(|(method, _)| method == "Tracing.tracingComplete")?;
                    events.remove(at).map(|(_, params)| params)
                });
                if let Some(params) = done {
                    return params.get("stream").and_then(Value::as_str).map(str::to_owned);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "the trace did not complete".to_string())?
        .ok_or("the trace has no stream")?;
        let mut out = std::fs::File::create(file).map_err(|e| e.to_string())?;
        let mut bytes = 0usize;
        loop {
            let chunk = self.dashboard("IO.read", json!({ "handle": stream, "size": 4 << 20 })).await?;
            let data = chunk.get("data").and_then(Value::as_str).unwrap_or("");
            out.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            bytes += data.len();
            if chunk.get("eof").and_then(Value::as_bool).unwrap_or(true) {
                break;
            }
        }
        let _ = self.dashboard("IO.close", json!({ "handle": stream })).await;
        Ok(json!({ "bytes": bytes }))
    }

    /// One DevTools call on the dashboard.
    pub async fn dashboard(&self, method: &str, params: Value) -> Result<Value, String> {
        let view = self.views.dashboard().ok_or("the dashboard is not up yet")?;
        view.cdp.call(method, params).await.map_err(|e| e.to_string())
    }

    /// The UI thread's stalls since the last read, as `{ "beats", "stalls": [[epoch ms, ms late]] }`.
    pub fn take_stalls(&self) -> Value {
        let mut stalls = self.stalls.lock().unwrap_or_else(|p| p.into_inner());
        let list: Vec<(u64, u64)> = stalls.list.drain(..).collect();
        let beats = std::mem::take(&mut stalls.beats);
        json!({ "beats": beats, "stalls": list })
    }
}
