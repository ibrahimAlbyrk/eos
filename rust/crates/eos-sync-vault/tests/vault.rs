//! The HTTP vault client, the key's crypto and the sync files
//! (`infra/src/__tests__/sync-vault.test.ts`), against the in-memory relay
//! vault on a loopback port.

#![allow(clippy::unwrap_used)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use eos_core::net::sync::{PutOutcome, SyncAccounts, SyncCrypto, SyncIdentityStore, SyncStateStore, SyncVault};
use eos_domain::sync::{IndexEntry, LocalState, SyncKeys, format_sync_key, parse_sync_key};
use eos_kit_net::{ClientOptions, http_client};
use eos_sync_vault::{
    FileSyncIdentityStore, FileSyncStateStore, HttpSyncVault, RelayAccounts, VaultCrypto, new_identity,
};
use eos_testkit::FakeClock;
use eos_testkit::vault::{FakeVault, VaultLimits};
use serde_json::json;

fn client() -> reqwest::Client {
    http_client(&ClientOptions::new("eos-test")).unwrap()
}

// ---- sync key ------------------------------------------------------------------

#[test]
fn the_key_round_trips_through_its_string_form() {
    let id = new_identity("wss://relay.example/");
    let parsed = parse_sync_key(&format!("  {}\n", format_sync_key(&id))).unwrap();
    assert_eq!(parsed.relay_url, "wss://relay.example/");
    assert_eq!(parsed.secret, id.secret);
    assert!(parse_sync_key("eos-sync1.abc").is_none());
    assert!(parse_sync_key(&format_sync_key(&id).replace("eos-sync1", "eos-sync2")).is_none());
    assert_ne!(new_identity("wss://r/").secret, id.secret, "a fresh secret every time");
}

#[test]
fn seals_records_so_only_the_same_key_for_the_same_record_opens_them() {
    let keys = SyncKeys::derive(&new_identity("wss://r/").secret);
    assert_eq!(keys.vault_id.len(), 32);
    assert!(keys.vault_id.bytes().all(|b| b.is_ascii_hexdigit()));
    let crypto = VaultCrypto::new(keys);
    let (k1, k2) = (crypto.record_key("memory", "um-1"), crypto.record_key("memory", "um-2"));
    assert_eq!(k1.len(), 64);
    let sealed = crypto.seal(&k1, b"hello");
    assert_eq!(crypto.open(&k1, &sealed).unwrap(), b"hello");
    assert!(crypto.open(&k2, &sealed).is_err());
    assert_ne!(crypto.seal(&k1, b"hello"), sealed, "a fresh nonce every time");
    let other = VaultCrypto::new(SyncKeys::derive(&new_identity("wss://r/").secret));
    assert!(other.open(&k1, &sealed).is_err());
}

// ---- the HTTP client against the vault ---------------------------------------------

struct Served {
    _served: eos_testkit::vault::ServedVault,
    url: String,
}

async fn relay() -> Served {
    let served = FakeVault::new(VaultLimits::default()).serve().await;
    let url = served.relay_url();
    Served { _served: served, url }
}

fn vault_for(url: &str, keys: &SyncKeys) -> HttpSyncVault {
    HttpSyncVault::new(client(), url, &keys.vault_id, &keys.auth_token)
}

#[tokio::test]
async fn writes_conflicts_and_reads_changes() {
    let relay = relay().await;
    let keys = SyncKeys::derive(&new_identity(&relay.url).secret);
    let vault = vault_for(&relay.url, &keys);
    let key = keys.record_key("page", "pg-1");
    assert_eq!(vault.put(&key, 0, &[1, 2]).await.unwrap(), PutOutcome::Stored { seq: 1 });
    let PutOutcome::Conflict { entry } = vault.put(&key, 0, &[3]).await.unwrap() else {
        panic!("a stale base conflicts")
    };
    assert_eq!((entry.seq, entry.data.as_slice()), (1, [1u8, 2].as_slice()));
    assert_eq!(vault.put(&key, 1, &[4]).await.unwrap(), PutOutcome::Stored { seq: 2 });
    let changes = vault.changes(0, 0).await.unwrap();
    assert_eq!(changes.head, 2);
    assert!(!changes.more);
    let read: Vec<(u64, &[u8])> = changes.entries.iter().map(|e| (e.seq, e.data.as_slice())).collect();
    assert_eq!(read, [(2, [4u8].as_slice())]);
}

#[tokio::test]
async fn a_long_poll_returns_as_soon_as_another_computer_writes() {
    let relay = relay().await;
    let keys = SyncKeys::derive(&new_identity(&relay.url).secret);
    let vault = Arc::new(vault_for(&relay.url, &keys));
    let started = Instant::now();
    let waiting = tokio::spawn({
        let vault = vault.clone();
        async move { vault.changes(0, 10_000).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let key = "a".repeat(64);
    vault.put(&key, 0, &[9]).await.unwrap();
    let got = waiting.await.unwrap().unwrap();
    assert_eq!(got.entries.len(), 1);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn refuses_a_different_key_on_the_same_vault() {
    let relay = relay().await;
    let keys = SyncKeys::derive(&new_identity(&relay.url).secret);
    vault_for(&relay.url, &keys).changes(0, 0).await.unwrap();
    let imposter = HttpSyncVault::new(client(), &relay.url, &keys.vault_id, &"x".repeat(43));
    let refused = imposter.changes(0, 0).await.unwrap_err();
    assert_eq!(refused.to_string(), "sync vault: 403 forbidden");
}

#[tokio::test]
async fn a_vault_that_lost_a_record_is_written_afresh() {
    let relay = relay().await;
    let keys = SyncKeys::derive(&new_identity(&relay.url).secret);
    let vault = vault_for(&relay.url, &keys);
    // This computer remembers seq 7 for a record the (reset) relay never saw.
    let key = keys.record_key("page", "pg-1");
    assert_eq!(vault.put(&key, 7, &[1]).await.unwrap(), PutOutcome::Stored { seq: 1 });
}

#[tokio::test]
async fn a_relay_that_is_not_there_is_an_error_naming_it() {
    // A port nothing listens on: bind one, then let it go.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let keys = SyncKeys::derive(&new_identity("ws://x/").secret);
    let vault = vault_for(&format!("ws://127.0.0.1:{port}/"), &keys);
    let failed = vault.changes(0, 0).await.unwrap_err();
    assert_eq!(failed.to_string(), format!("sync vault: 127.0.0.1:{port} can't be reached"));
}

#[tokio::test]
async fn an_account_opens_its_own_vault_and_seals_for_it() {
    let relay = relay().await;
    let accounts = RelayAccounts::new(client());
    let identity = accounts.create(&relay.url);
    let (a, b) = (accounts.open(&identity), accounts.open(&identity));
    let key = a.crypto.record_key("memory", "um-1");
    let sealed = a.crypto.seal(&key, b"note");
    assert_eq!(a.vault.put(&key, 0, &sealed).await.unwrap(), PutOutcome::Stored { seq: 1 });
    let page = b.vault.changes(0, 0).await.unwrap();
    assert_eq!(b.crypto.open(&page.entries[0].key, &page.entries[0].data).unwrap(), b"note");
    // Another account on the same relay sees none of it.
    let other = accounts.open(&accounts.create(&relay.url));
    assert!(other.vault.changes(0, 0).await.unwrap().entries.is_empty());
}

// ---- the files --------------------------------------------------------------------

#[test]
fn stores_keep_state_conflicts_and_an_owner_only_identity() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(FakeClock::new());
    let state = FileSyncStateStore::new(dir.path(), clock.clone());
    assert_eq!(state.load(), LocalState::default());
    let mut saved = LocalState { cursor: 7, ..LocalState::default() };
    saved.index.insert("memory/um-1".into(), IndexEntry { seq: 7, hash: Some("h".into()) });
    state.save(&saved).unwrap();
    assert_eq!(state.load(), saved);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("state.json")).unwrap(),
        r#"{"cursor":7,"index":{"memory/um-1":{"seq":7,"hash":"h"}}}"#
    );

    state.save_conflict("worker", "../evil", &json!({ "md": "x" })).unwrap();
    state.save_conflict("worker", "../evil", &json!({ "md": "y" })).unwrap();
    let mut kept: Vec<String> = std::fs::read_dir(dir.path().join("conflicts/worker"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    kept.sort();
    // Both losing versions of the same millisecond are there, inside the folder.
    assert_eq!(kept, [".._evil.2027-01-15T08-00-00-000-2.json", ".._evil.2027-01-15T08-00-00-000.json"]);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("conflicts/worker").join(&kept[1])).unwrap(),
        "{\n  \"md\": \"x\"\n}"
    );

    state.reset().unwrap();
    state.reset().unwrap();
    assert_eq!(state.load(), LocalState::default());
    std::fs::write(dir.path().join("state.json"), "{ not json").unwrap();
    assert_eq!(state.load(), LocalState::default(), "an unreadable state is an empty one");

    let identities = FileSyncIdentityStore::new(dir.path());
    assert!(identities.load().is_none());
    let identity = new_identity("wss://r/");
    identities.save(&identity).unwrap();
    assert_eq!(identities.load(), Some(identity));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join("identity.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    identities.clear().unwrap();
    identities.clear().unwrap();
    assert!(identities.load().is_none());
}

#[test]
fn an_identity_file_written_by_the_typescript_app_is_read() {
    let dir = tempfile::tempdir().unwrap();
    // infra/src/sync/stores.ts: {"relayUrl":…,"secret":<base64url of 32 bytes>}
    let secret = "VvhpXHc1JwTFwZEFiNDSohG7wN7QkqCUBVm8xSa_NFw";
    std::fs::write(
        dir.path().join("identity.json"),
        format!(r#"{{"relayUrl":"wss://relay.example.test/eos","secret":"{secret}"}}"#),
    )
    .unwrap();
    let identity = FileSyncIdentityStore::new(dir.path()).load().unwrap();
    assert_eq!(
        format_sync_key(&identity),
        format!("eos-sync1.d3NzOi8vcmVsYXkuZXhhbXBsZS50ZXN0L2Vvcw.{secret}"),
        "the vector file's key"
    );
}
