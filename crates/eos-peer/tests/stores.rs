//! An existing pairing must survive the move to the Rust app, and a pairing it
//! makes must stay readable by a 0.1.x app: the three lists and the relay room
//! in `tests/vectors/stores` were written by the 0.1.x app's stores from the
//! records below.

use std::path::{Path, PathBuf};

use eos_contracts::{Fingerprint, KnownHost, OpenInvite, PairedDevice, RelayGrant};
use eos_peer::{Identity, stores};
use eos_testkit::TempHome;

const LISTS: [&str; 3] = ["devices.json", "invites.json", "hosts.json"];

fn vectors() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/stores")
}

fn read(dir: &Path, file: &str) -> String {
    std::fs::read_to_string(dir.join(file)).unwrap_or_else(|e| panic!("{file}: {e}"))
}

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

#[test]
fn reads_what_the_previous_app_wrote() {
    let home = TempHome::new();
    let dir = home.join("peer");
    std::fs::create_dir_all(&dir).expect("made");
    for file in LISTS.iter().chain(&["relay-room.json"]) {
        std::fs::copy(vectors().join(file), dir.join(file)).expect("copied");
    }
    assert_eq!(stores::paired_devices(&dir).list(), devices());
    assert_eq!(stores::open_invites(&dir).list(), invites());
    assert_eq!(stores::known_hosts(&dir).list(), hosts());
    let (room, owner) = stores::load_or_create_relay_room(&dir).expect("the room reads");
    let frozen: serde_json::Value = serde_json::from_str(&read(&vectors(), "relay-room.json")).expect("JSON");
    assert_eq!((frozen["room"].as_str(), frozen["owner"].as_str()), (Some(room.as_str()), Some(owner.as_str())));
}

#[test]
fn writes_the_same_bytes_as_the_previous_app() {
    let home = TempHome::new();
    let dir = home.join("peer");
    Identity::load_or_create(&dir, 1_762_000_000_000).expect("minted");
    let (devices_store, invites_store, hosts_store) =
        (stores::paired_devices(&dir), stores::open_invites(&dir), stores::known_hosts(&dir));
    devices().into_iter().for_each(|d| devices_store.upsert(d));
    invites().into_iter().for_each(|i| invites_store.upsert(i));
    hosts().into_iter().for_each(|h| hosts_store.upsert(h));
    stores::load_or_create_relay_room(&dir).expect("minted");

    for file in LISTS {
        assert_eq!(read(&dir, file), read(&vectors(), file), "{file}");
    }
    // Same shape for the room (its values are random).
    assert_eq!(read(&dir, "relay-room.json").len(), read(&vectors(), "relay-room.json").len());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in ["device.key", "device.crt", "devices.json", "hosts.json", "invites.json", "relay-room.json"] {
            let mode = std::fs::metadata(dir.join(file)).expect("exists").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{file}");
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
