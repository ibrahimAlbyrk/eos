//! The relay's hook inbox, for tests: [`FakeHookRelay`] answers the HTTP API
//! of `relay/hooks/routes.ts` on a loopback port and seals what it is handed
//! as the real one does; [`FakeHookInbox`] is the port in memory.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use eos_core::net::hooks::{HookBatch, HookEvent, HookInbox, HookUrl};
use eos_core::{BoxFuture, Error};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::push::read_request;
use super::registry::sha256_hex;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Debug, Default)]
struct Inbox {
    bearer_hash: String,
    public_key: [u8; 32],
    head: u64,
    events: Vec<(u64, Vec<u8>)>,
    dropped: u64,
}

#[derive(Debug, Default)]
struct Desk {
    inboxes: HashMap<String, Inbox>,
    /// hook -> inbox
    hooks: HashMap<String, String>,
    acks: Vec<u64>,
    requests: usize,
}

/// `relay/hooks/` on a loopback port. Stops when dropped.
#[derive(Debug)]
pub struct FakeHookRelay {
    port: u16,
    desk: Arc<Mutex<Desk>>,
    landed: Arc<Notify>,
    seals: AtomicU64,
    task: JoinHandle<()>,
}

impl Drop for FakeHookRelay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeHookRelay {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
        let port = listener.local_addr().expect("an address").port();
        let desk = Arc::new(Mutex::new(Desk::default()));
        let landed = Arc::new(Notify::new());
        let (serving, woken) = (desk.clone(), landed.clone());
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(serve(tcp, serving.clone(), woken.clone()));
            }
        });
        Self { port, desk, landed, seals: AtomicU64::new(0), task }
    }

    /// The relay's URL as the phone link names it.
    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port)
    }

    /// What an outside service's post to `hook` leaves: sealed to its inbox's
    /// key as the relay seals. `false` for a hook the relay does not hold.
    pub fn deliver(&self, hook: &str, received_at: i64, headers: &[(&str, &str)], body: &[u8]) -> bool {
        let headers: serde_json::Map<String, Value> =
            headers.iter().map(|(name, value)| ((*name).to_owned(), Value::from(*value))).collect();
        let plaintext =
            json!({ "hook": hook, "receivedAt": received_at, "headers": headers, "body": STANDARD.encode(body) });
        let n = self.seals.fetch_add(1, Ordering::SeqCst) as u8;
        let mut desk = lock(&self.desk);
        let Some(inbox) = desk.hooks.get(hook).cloned() else { return false };
        let Some(inbox) = desk.inboxes.get_mut(&inbox) else { return false };
        let sealed = eos_relay::seal::seal(
            &inbox.public_key,
            plaintext.to_string().as_bytes(),
            [n.wrapping_add(1); 32],
            [n; 12],
        );
        inbox.head += 1;
        inbox.events.push((inbox.head, sealed));
        drop(desk);
        self.landed.notify_waiters();
        true
    }

    /// An entry that opens with nobody's key (a relay that lost its mind, or
    /// one that tries to plant an event).
    pub fn plant_unreadable(&self, inbox: &str) {
        let mut desk = lock(&self.desk);
        let Some(inbox) = desk.inboxes.get_mut(inbox) else { return };
        inbox.head += 1;
        inbox.events.push((inbox.head, vec![9; 80]));
    }

    /// The relay swept `count` events past their seven days.
    pub fn drop_events(&self, inbox: &str, count: u64) {
        if let Some(inbox) = lock(&self.desk).inboxes.get_mut(inbox) {
            inbox.dropped += count;
        }
    }

    /// The hooks the relay holds, in no order.
    pub fn hooks(&self) -> Vec<String> {
        lock(&self.desk).hooks.keys().cloned().collect()
    }

    /// The key the relay seals `inbox`'s events to.
    pub fn public_key(&self, inbox: &str) -> Option<[u8; 32]> {
        lock(&self.desk).inboxes.get(inbox).map(|inbox| inbox.public_key)
    }

    /// Every `through` the Mac acked, in order.
    pub fn acks(&self) -> Vec<u64> {
        lock(&self.desk).acks.clone()
    }

    /// Requests the relay answered.
    pub fn requests(&self) -> usize {
        lock(&self.desk).requests
    }
}

async fn serve(mut tcp: TcpStream, desk: Arc<Mutex<Desk>>, landed: Arc<Notify>) {
    let Some((head, body)) = read_request(&mut tcp).await else { return };
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split(' ');
    let (method, target) = (start.next().unwrap_or_default().to_owned(), start.next().unwrap_or_default().to_owned());
    let bearer = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("authorization").then(|| value.trim().strip_prefix("Bearer ")).flatten()
    });
    let bearer = bearer.map(str::to_owned);
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let param = |name: &str| {
        query.split('&').find_map(|pair| pair.strip_prefix(name)?.strip_prefix('=')?.parse::<u64>().ok()).unwrap_or(0)
    };
    let mut answer = route(&desk, &method, path, bearer.as_deref(), &body, param("since"));
    if method == "GET" && answer.1.get("entries").is_some_and(|e| e.as_array().is_some_and(Vec::is_empty)) {
        let wait = Duration::from_secs(param("wait"));
        if !wait.is_zero() {
            let _ = tokio::time::timeout(wait, landed.notified()).await;
            answer = route(&desk, &method, path, bearer.as_deref(), &body, param("since"));
        }
    }
    lock(&desk).requests += 1;
    let (status, json) = answer;
    let text = json.to_string();
    let response = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = tcp.write_all(response.as_bytes()).await;
    let _ = tcp.shutdown().await;
}

fn route(desk: &Mutex<Desk>, method: &str, path: &str, bearer: Option<&str>, body: &[u8], since: u64) -> (u16, Value) {
    let error = |status: u16, message: &str| (status, json!({ "error": message }));
    let Some(rest) = path.strip_prefix("/hooks/v1/") else { return error(404, "not found") };
    let mut parts = rest.split('/');
    let inbox = parts.next().unwrap_or_default().to_owned();
    let tail: Vec<&str> = parts.collect();
    let Some(bearer) = bearer else { return error(401, "unauthorized") };
    let mut desk = lock(desk);
    if tail.is_empty() && method == "PUT" {
        let body: Value = serde_json::from_slice(body).unwrap_or_default();
        let key = body["publicKey"].as_str().and_then(|key| STANDARD.decode(key).ok());
        let Some(key) = key.and_then(|key| <[u8; 32]>::try_from(key).ok()) else { return error(400, "bad publicKey") };
        let entry =
            desk.inboxes.entry(inbox).or_insert_with(|| Inbox { bearer_hash: sha256_hex(bearer), ..Inbox::default() });
        if entry.bearer_hash != sha256_hex(bearer) {
            return error(403, "forbidden");
        }
        entry.public_key = key;
        return (200, json!({}));
    }
    match desk.inboxes.get(&inbox) {
        None => return error(404, "unknown inbox"),
        Some(held) if held.bearer_hash != sha256_hex(bearer) => return error(403, "forbidden"),
        Some(_) => {}
    }
    match (method, tail.as_slice()) {
        ("GET", ["events"]) => {
            let held = &desk.inboxes[&inbox];
            let entries: Vec<Value> = held
                .events
                .iter()
                .filter(|(seq, _)| *seq > since)
                .map(|(seq, sealed)| json!({ "seq": seq, "sealed": STANDARD.encode(sealed) }))
                .collect();
            (200, json!({ "head": held.head, "entries": entries, "dropped": held.dropped }))
        }
        ("POST", ["ack"]) => {
            let body: Value = serde_json::from_slice(body).unwrap_or_default();
            let Some(through) = body["through"].as_u64() else { return error(400, "bad through") };
            desk.acks.push(through);
            if let Some(held) = desk.inboxes.get_mut(&inbox) {
                held.events.retain(|(seq, _)| *seq > through);
            }
            (200, json!({}))
        }
        ("PUT", ["hooks", hook]) => match desk.hooks.get(*hook) {
            Some(owner) if *owner != inbox => error(409, "hook taken"),
            _ => {
                desk.hooks.insert((*hook).to_owned(), inbox);
                (200, json!({}))
            }
        },
        ("DELETE", ["hooks", hook]) => {
            if desk.hooks.get(*hook) == Some(&inbox) {
                desk.hooks.remove(*hook);
            }
            (200, json!({}))
        }
        _ => error(404, "not found"),
    }
}

#[derive(Debug, Default)]
struct InboxState {
    events: Vec<HookEvent>,
    head: u64,
    unreadable: u32,
    dropped: u64,
    hooks: Vec<String>,
    revoked: Vec<String>,
    acks: Vec<u64>,
    ensured: usize,
    reads: usize,
    fail: Option<Error>,
}

/// [`HookInbox`] in memory: events the test adds, every ack and hook kept.
/// A read with nothing new waits for the next event or the wait's end on
/// tokio's clock.
#[derive(Debug, Default)]
pub struct FakeHookInbox {
    state: Mutex<InboxState>,
    landed: Notify,
}

impl FakeHookInbox {
    pub fn new() -> Self {
        Self::default()
    }

    /// An event the relay opened for this computer; its seq is the next one.
    pub fn add(&self, hook: &str, received_at: i64, headers: &[(&str, &str)], body: &[u8]) -> u64 {
        let mut state = lock(&self.state);
        state.head += 1;
        let seq = state.head;
        let headers = headers.iter().map(|(n, v)| ((*n).to_owned(), (*v).to_owned())).collect();
        state.events.push(HookEvent { seq, hook: hook.to_owned(), received_at, headers, body: body.to_vec() });
        drop(state);
        self.landed.notify_waiters();
        seq
    }

    /// An entry that did not open: the next read counts it.
    pub fn add_unreadable(&self) {
        let mut state = lock(&self.state);
        state.head += 1;
        state.unreadable += 1;
        drop(state);
        self.landed.notify_waiters();
    }

    /// The relay's lifetime count of events it dropped unread.
    pub fn set_dropped(&self, dropped: u64) {
        lock(&self.state).dropped = dropped;
    }

    /// The next call fails with `error`.
    pub fn fail_next(&self, error: Error) {
        lock(&self.state).fail = Some(error);
    }

    pub fn acks(&self) -> Vec<u64> {
        lock(&self.state).acks.clone()
    }

    pub fn hooks(&self) -> Vec<String> {
        lock(&self.state).hooks.clone()
    }

    pub fn revoked(&self) -> Vec<String> {
        lock(&self.state).revoked.clone()
    }

    pub fn ensured(&self) -> usize {
        lock(&self.state).ensured
    }

    /// Reads of the inbox so far.
    pub fn reads(&self) -> usize {
        lock(&self.state).reads
    }

    fn take_failure(&self) -> Result<(), Error> {
        lock(&self.state).fail.take().map_or(Ok(()), Err)
    }

    fn batch(&self, since: u64) -> HookBatch {
        let mut state = lock(&self.state);
        let unreadable = std::mem::take(&mut state.unreadable);
        let events = state.events.iter().filter(|event| event.seq > since).cloned().collect();
        HookBatch { head: state.head, events, unreadable, dropped: state.dropped }
    }
}

impl HookInbox for FakeHookInbox {
    fn ensure(&self) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            self.take_failure()?;
            lock(&self.state).ensured += 1;
            Ok(())
        })
    }

    fn create_hook(&self) -> BoxFuture<'_, Result<HookUrl, Error>> {
        Box::pin(async move {
            self.take_failure()?;
            let mut state = lock(&self.state);
            let id = format!("{:032x}", state.hooks.len() + 1);
            state.hooks.push(id.clone());
            Ok(HookUrl { url: format!("https://relay.test/hooks/v1/{}/{id}", "0f".repeat(16)), id })
        })
    }

    fn revoke_hook<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            self.take_failure()?;
            let mut state = lock(&self.state);
            state.hooks.retain(|hook| hook != id);
            state.revoked.push(id.to_owned());
            Ok(())
        })
    }

    fn next(&self, since: u64, wait_ms: u64) -> BoxFuture<'_, Result<HookBatch, Error>> {
        Box::pin(async move {
            lock(&self.state).reads += 1;
            self.take_failure()?;
            let landed = self.landed.notified();
            let batch = self.batch(since);
            if batch.events.is_empty() && batch.unreadable == 0 && wait_ms > 0 {
                let _ = tokio::time::timeout(Duration::from_millis(wait_ms), landed).await;
                return Ok(self.batch(since));
            }
            Ok(batch)
        })
    }

    fn ack(&self, through: u64) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            self.take_failure()?;
            let mut state = lock(&self.state);
            state.acks.push(through);
            state.events.retain(|event| event.seq > through);
            Ok(())
        })
    }
}
