//! An existing pairing must survive the move to Rust, and a pairing made by
//! the Rust app must be readable by a TypeScript-era one: the identity files
//! and the three lists are written by one implementation and read by the other.

mod support;

use eos_contracts::{Fingerprint, KnownHost, OpenInvite, PairedDevice, RelayGrant};
use eos_peer::{Identity, stores};
use eos_testkit::TempHome;
use serde_json::json;
use support::Node;

fn devices() -> Vec<PairedDevice> {
    vec![
        PairedDevice {
            fp: Fingerprint("a1".repeat(32)),
            name: "Studio — “Büro”".into(),
            platform: "darwin".into(),
            paired_at: 1_762_000_000_123_i64.into(),
            last_seen_at: Some(1_762_000_500_000_i64.into()),
            relay_bearer_hash: Some("0f".repeat(32)),
        },
        PairedDevice {
            fp: Fingerprint("b2".repeat(32)),
            name: "Laptop".into(),
            platform: "win32".into(),
            paired_at: 1_762_000_000_456_i64.into(),
            last_seen_at: None,
            relay_bearer_hash: None,
        },
    ]
}

fn invites() -> Vec<OpenInvite> {
    vec![OpenInvite { hash: "c3".repeat(32), join_hash: "d4".repeat(32), created_at: 1_762_000_000_789_i64.into() }]
}

fn hosts() -> Vec<KnownHost> {
    vec![
        KnownHost {
            id: Fingerprint("e5".repeat(32)),
            name: "Office iMac".into(),
            alias: Some("desk".into()),
            platform: "darwin".into(),
            addrs: vec!["192.168.1.20:7402".into(), "[fd7a:115c::1]:7402".into()],
            relay: Some(RelayGrant {
                url: "wss://relay.invalid/ws".into(),
                room: "r".repeat(43),
                bearer: "b".repeat(43),
            }),
            paired_at: 1_762_000_001_000_i64.into(),
            last_connected_at: Some(1_762_000_002_000_i64.into()),
        },
        KnownHost {
            id: Fingerprint("f6".repeat(32)),
            name: "Mini".into(),
            alias: None,
            platform: "darwin".into(),
            addrs: vec![],
            relay: None,
            paired_at: 1_762_000_003_000_i64.into(),
            last_connected_at: None,
        },
    ]
}

#[tokio::test]
async fn rust_reads_what_typescript_wrote() {
    let Some(mut node) = Node::start().await else { return };
    let home = TempHome::new();
    let dir = home.join("peer");
    let minted = node.call("identity", json!({ "dir": dir })).await;
    let written = node
        .call("stores.write", json!({ "dir": dir, "devices": devices(), "invites": invites(), "hosts": hosts() }))
        .await;

    let identity = Identity::load_or_create(&dir, 0).expect("the TypeScript identity loads");
    assert_eq!(identity.fingerprint(), minted["fingerprint"], "fingerprint = sha256 over the certificate");
    assert_eq!(stores::paired_devices(&dir).list(), devices());
    assert_eq!(stores::open_invites(&dir).list(), invites());
    assert_eq!(stores::known_hosts(&dir).list(), hosts());
    let (room, owner) = stores::load_or_create_relay_room(&dir).expect("the room reads");
    assert_eq!(json!({ "room": room, "owner": owner }), written["relayRoom"]);

    // Loading never rewrote the identity.
    let again = node.call("identity", json!({ "dir": dir })).await;
    assert_eq!(again["fingerprint"], minted["fingerprint"]);
}

#[tokio::test]
async fn typescript_reads_what_rust_wrote_and_the_files_are_the_same_bytes() {
    let Some(mut node) = Node::start().await else { return };
    let home = TempHome::new();
    let (rust_dir, ts_dir) = (home.join("rust/peer"), home.join("ts/peer"));

    let identity = Identity::load_or_create(&rust_dir, 1_762_000_000_000).expect("minted");
    let (devices_store, invites_store, hosts_store) =
        (stores::paired_devices(&rust_dir), stores::open_invites(&rust_dir), stores::known_hosts(&rust_dir));
    devices().into_iter().for_each(|d| devices_store.upsert(d));
    invites().into_iter().for_each(|i| invites_store.upsert(i));
    hosts().into_iter().for_each(|h| hosts_store.upsert(h));
    let (room, owner) = stores::load_or_create_relay_room(&rust_dir).expect("minted");

    let seen = node.call("identity", json!({ "dir": rust_dir })).await;
    assert_eq!(seen["fingerprint"], identity.fingerprint());
    assert_eq!(seen["keyMatches"], true, "the key belongs to the certificate");
    assert_eq!(seen["selfSigned"], true);
    assert_eq!(seen["subject"], "CN=eos-device");
    assert_eq!(seen["validTo"], "Dec 31 23:59:59 9999 GMT");
    assert_eq!((seen["keyType"].as_str(), seen["curve"].as_str()), (Some("ec"), Some("prime256v1")));

    let read = node.call("stores.read", json!({ "dir": rust_dir })).await;
    assert_eq!(read["devices"], json!(devices()));
    assert_eq!(read["invites"], json!(invites()));
    assert_eq!(read["hosts"], json!(hosts()));
    assert_eq!(read["relayRoom"], json!({ "room": room, "owner": owner }));

    // The same records through the TypeScript stores: byte for byte the same files.
    node.call("identity", json!({ "dir": ts_dir })).await;
    node.call("stores.write", json!({ "dir": ts_dir, "devices": devices(), "invites": invites(), "hosts": hosts() }))
        .await;
    let theirs = node.call("stores.read", json!({ "dir": ts_dir })).await;
    for file in ["devices.json", "invites.json", "hosts.json"] {
        assert_eq!(read["raw"][file], theirs["raw"][file], "{file}");
    }
    // Same shape for the room (its values are random on each side).
    let shape = |raw: &serde_json::Value| raw.as_str().map(|s| s.len());
    assert_eq!(shape(&read["raw"]["relay-room.json"]), shape(&theirs["raw"]["relay-room.json"]));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in ["device.key", "device.crt", "devices.json", "hosts.json", "invites.json", "relay-room.json"] {
            let mode = |dir: &std::path::Path| std::fs::metadata(dir.join(file)).expect("exists").permissions().mode();
            assert_eq!(mode(&rust_dir) & 0o777, 0o600, "{file}");
            assert_eq!(mode(&rust_dir) & 0o777, mode(&ts_dir) & 0o777, "{file}: as TypeScript leaves it");
        }
    }
}

#[test]
fn an_unreadable_identity_is_an_error_and_is_never_replaced() {
    let home = TempHome::new();
    home.write("peer/device.key", "not a key");
    home.write("peer/device.crt", "not a certificate");
    let err = Identity::load_or_create(&home.join("peer"), 0).expect_err("refused");
    assert!(matches!(err, eos_peer::Error::BadIdentity { .. }), "{err}");
    assert_eq!(home.read("peer/device.key"), "not a key", "left as it was");
}
