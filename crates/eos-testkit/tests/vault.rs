//! The in-memory vault held to what the relay's own tests pin
//! (`relay/__tests__/vault.test.ts`): whatever passes there must pass here,
//! or the sync code would be tested against a vault that does not exist.
//! ("The store survives a reopen" has no counterpart: this one is in memory.)

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use eos_testkit::vault::{Authorized, FakeVault, StorePut, VaultLimits, VaultRequest, VaultResponse};
use serde_json::{Value, json};

const VAULT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN: &str = "token-0123456789abcdef";
const ELSE: &str = "someone-else-0123456";

fn key(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}

fn store(max_vaults: usize, max_vault_bytes: usize) -> Arc<FakeVault> {
    FakeVault::new(VaultLimits { max_vaults, max_vault_bytes, ..VaultLimits::default() })
}

fn seqs(put: StorePut) -> u64 {
    match put {
        StorePut::Stored { seq } => seq,
        other => panic!("not stored: {other:?}"),
    }
}

// ---- the store ---------------------------------------------------------------

#[test]
fn put_is_a_compare_and_swap_per_key_and_seq_is_per_vault() {
    let s = store(16, 1024);
    assert_eq!(s.authorize(VAULT, TOKEN), Authorized::Ok);
    assert_eq!(s.put(VAULT, &key('c'), 0, b"one"), StorePut::Stored { seq: 1 });
    assert_eq!(s.put(VAULT, &key('d'), 0, b"two"), StorePut::Stored { seq: 2 });

    let StorePut::Conflict { entry: Some(entry) } = s.put(VAULT, &key('c'), 0, b"lost") else {
        panic!("a stale base must conflict")
    };
    assert_eq!((entry.seq, entry.data.as_slice()), (1, b"one".as_slice()));

    assert_eq!(s.put(VAULT, &key('c'), 1, b"one-v2"), StorePut::Stored { seq: 3 });
    // A key the vault never saw only accepts base 0.
    assert_eq!(s.put(VAULT, &key('e'), 5, b"x"), StorePut::Conflict { entry: None });
}

#[test]
fn changes_pages_in_seq_order_from_since() {
    let s = store(16, 1024);
    s.authorize(VAULT, TOKEN);
    let empty = s.changes(VAULT, 0, 10);
    assert_eq!((empty.head, empty.entries.len(), empty.more), (0, 0, false));
    for i in 0..5u8 {
        s.put(VAULT, &key(char::from(b'0' + i)), 0, format!("r{i}").as_bytes());
    }
    s.put(VAULT, &key('0'), 1, b"r0-v2");

    let first = s.changes(VAULT, 0, 2);
    assert_eq!(first.head, 6);
    assert_eq!(first.entries.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    assert!(first.more);
    let rest = s.changes(VAULT, 3, 10);
    let read: Vec<(u64, &[u8])> = rest.entries.iter().map(|e| (e.seq, e.data.as_slice())).collect();
    assert_eq!(read, [(4, b"r3".as_slice()), (5, b"r4".as_slice()), (6, b"r0-v2".as_slice())]);
    assert!(!rest.more);
    let other = s.changes(OTHER, 0, 10);
    assert_eq!((other.head, other.entries.len(), other.more), (0, 0, false));
}

#[test]
fn authorize_pins_the_first_token_refuses_others_and_new_vaults_past_the_cap() {
    let s = store(1, 1024);
    assert_eq!(s.authorize(VAULT, TOKEN), Authorized::Ok);
    assert_eq!(s.authorize(VAULT, TOKEN), Authorized::Ok);
    assert_eq!(s.authorize(VAULT, ELSE), Authorized::Forbidden);
    assert_eq!(s.authorize(OTHER, TOKEN), Authorized::Full);
}

#[test]
fn put_past_the_vault_quota_is_refused_and_replacing_counts_the_delta() {
    let s = store(16, 10);
    s.authorize(VAULT, TOKEN);
    assert_eq!(seqs(s.put(VAULT, &key('c'), 0, &[0; 8])), 1);
    assert_eq!(s.put(VAULT, &key('d'), 0, &[0; 3]), StorePut::Quota);
    // The refused put left nothing behind.
    assert_eq!(s.changes(VAULT, 0, 10).head, 1);
    assert_eq!(s.put(VAULT, &key('c'), 1, &[0; 10]), StorePut::Stored { seq: 2 });
}

// ---- the routes --------------------------------------------------------------

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

async fn call(vault: &FakeVault, method: &str, target: &str, token: Option<&str>, body: &[u8]) -> VaultResponse {
    let authorization = token.map(bearer);
    let request = VaultRequest {
        method,
        target,
        authorization: authorization.as_deref(),
        content_length: (!body.is_empty()).then_some(body.len()),
        body,
    };
    vault.handle(request).await.expect("a vault route")
}

async fn put_record(vault: &FakeVault, key: &str, base_seq: u64, data: &str, token: &str) -> VaultResponse {
    let body = json!({ "baseSeq": base_seq, "data": STANDARD.encode(data) }).to_string();
    call(vault, "PUT", &format!("/vault/v1/{VAULT}/records/{key}"), Some(token), body.as_bytes()).await
}

fn limits(change: impl FnOnce(&mut VaultLimits)) -> Arc<FakeVault> {
    let mut limits = VaultLimits::default();
    change(&mut limits);
    FakeVault::new(limits)
}

#[tokio::test]
async fn put_then_get_changes_and_409_on_a_stale_base() {
    let vault = FakeVault::new(VaultLimits::default());
    let put = put_record(&vault, &key('c'), 0, "hello", TOKEN).await;
    assert_eq!((put.status, &put.body), (200, &json!({ "seq": 1 })));

    let changes = call(&vault, "GET", &format!("/vault/v1/{VAULT}/changes?since=0"), Some(TOKEN), b"").await;
    assert_eq!(changes.status, 200);
    let entry = json!({ "key": key('c'), "seq": 1, "data": STANDARD.encode("hello") });
    assert_eq!(changes.body, json!({ "head": 1, "entries": [entry], "more": false }));

    let stale = put_record(&vault, &key('c'), 0, "again", TOKEN).await;
    assert_eq!(stale.status, 409);
    assert_eq!(stale.body["entry"], entry);
}

#[tokio::test]
async fn auth_is_401_without_a_bearer_403_for_a_different_one_503_past_the_vault_cap() {
    let vault = limits(|l| l.max_vaults = 1);
    let changes = format!("/vault/v1/{VAULT}/changes");
    assert_eq!(call(&vault, "GET", &changes, None, b"").await.status, 401);
    assert_eq!(call(&vault, "GET", &changes, Some("short"), b"").await.status, 401);
    assert_eq!(call(&vault, "GET", &changes, Some(TOKEN), b"").await.status, 200);
    assert_eq!(call(&vault, "GET", &changes, Some(ELSE), b"").await.status, 403);
    assert_eq!(put_record(&vault, &key('c'), 0, "x", ELSE).await.status, 403);
    let full = call(&vault, "GET", &format!("/vault/v1/{OTHER}/changes"), Some(TOKEN), b"").await;
    assert_eq!((full.status, full.body), (503, json!({ "error": "vault limit" })));
}

#[tokio::test]
async fn bad_ids_bodies_and_oversized_blobs_are_refused() {
    let vault = limits(|l| l.max_blob_bytes = 16);
    let record = format!("/vault/v1/{VAULT}/records/{}", key('c'));
    let status = |response: VaultResponse| response.status;
    assert_eq!(status(call(&vault, "GET", "/vault/v1/NOT-A-VAULT/changes", Some(TOKEN), b"").await), 400);
    assert_eq!(status(call(&vault, "PUT", &format!("/vault/v1/{VAULT}/records/short"), Some(TOKEN), b"{}").await), 400);
    assert_eq!(status(call(&vault, "PUT", &record, Some(TOKEN), b"nope").await), 400);
    assert_eq!(status(call(&vault, "PUT", &record, Some(TOKEN), br#"{"baseSeq":-1,"data":""}"#).await), 400);
    assert_eq!(status(call(&vault, "PUT", &record, Some(TOKEN), br#"{"baseSeq":0,"data":"a"}"#).await), 400);
    let wrong_method = call(&vault, "PUT", &format!("/vault/v1/{VAULT}/changes"), Some(TOKEN), b"").await;
    assert_eq!(wrong_method.status, 405);
    assert_eq!(wrong_method.headers, [("allow", "GET".to_owned())]);
    assert_eq!(status(call(&vault, "GET", &format!("/vault/v1/{VAULT}/elsewhere"), Some(TOKEN), b"").await), 404);
    // Decoded size over the cap, raw body still under the read cap.
    assert_eq!(status(put_record(&vault, &key('c'), 0, &"x".repeat(17), TOKEN).await), 413);
    // Raw body over the read cap.
    assert_eq!(status(put_record(&vault, &key('c'), 0, &"x".repeat(4096), TOKEN).await), 413);
    assert!(
        vault.handle(VaultRequest { method: "GET", target: "/elsewhere", ..VaultRequest::default() }).await.is_none()
    );
}

#[tokio::test]
async fn a_put_past_the_vault_quota_is_507() {
    let vault = limits(|l| l.max_vault_bytes = 10);
    assert_eq!(put_record(&vault, &key('c'), 0, "12345678", TOKEN).await.status, 200);
    assert_eq!(put_record(&vault, &key('d'), 0, "123", TOKEN).await.status, 507);
}

#[tokio::test(start_paused = true)]
async fn a_long_poll_wakes_on_a_put_and_times_out_empty() {
    let vault = FakeVault::new(VaultLimits::default());
    let polling = {
        let vault = vault.clone();
        tokio::spawn(async move {
            call(&vault, "GET", &format!("/vault/v1/{VAULT}/changes?since=0&wait=20"), Some(TOKEN), b"").await
        })
    };
    while vault.parked(VAULT) == 0 {
        tokio::task::yield_now().await;
    }
    let started = tokio::time::Instant::now();
    assert_eq!(put_record(&vault, &key('c'), 0, "wake", TOKEN).await.status, 200);
    let woke = polling.await.expect("the poll");
    assert!(started.elapsed() < Duration::from_secs(5), "answered on the put, not the timeout");
    let seqs: Vec<&Value> = woke.body["entries"].as_array().expect("entries").iter().map(|e| &e["seq"]).collect();
    assert_eq!(seqs, [&json!(1)]);

    let idle = tokio::time::Instant::now();
    let empty = call(&vault, "GET", &format!("/vault/v1/{VAULT}/changes?since=1&wait=1"), Some(TOKEN), b"").await;
    assert!(idle.elapsed() >= Duration::from_millis(900), "held for the wait");
    assert_eq!(empty.body, json!({ "head": 1, "entries": [], "more": false }));
    assert_eq!(vault.parked_vaults(), 0);
}

#[tokio::test]
async fn a_client_that_gives_up_on_a_long_poll_is_unparked() {
    use tokio::io::AsyncWriteExt;

    let vault = FakeVault::new(VaultLimits::default());
    let served = vault.serve().await;
    let address = served.http_base().trim_start_matches("http://").to_owned();
    let mut socket = tokio::net::TcpStream::connect(&address).await.expect("the loopback server");
    let request = format!(
        "GET /vault/v1/{VAULT}/changes?wait=20 HTTP/1.1\r\nhost: {address}\r\nauthorization: Bearer {TOKEN}\r\n\r\n"
    );
    socket.write_all(request.as_bytes()).await.expect("sent");
    while vault.parked(VAULT) != 1 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    drop(socket);
    while vault.parked_vaults() != 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
