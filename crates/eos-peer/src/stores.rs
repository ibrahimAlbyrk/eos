//! Peering state under `<home>/peer/`, in today's formats: small JSON lists,
//! each rewritten whole and atomically, readable by the user only (they hold
//! relay bearers).
//!
//! | File | Holds |
//! |---|---|
//! | `devices.json` | the devices allowed to control this computer |
//! | `invites.json` | invites still open here, as hashes |
//! | `hosts.json` | the computers this one controls, with their relay bearers |
//! | `relay-room.json` | this computer's own room on a relay |

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use eos_contracts::{KnownHost, OpenInvite, PairedDevice, Validate};
use eos_kit_fs::{WriteOptions, atomic_write};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::Error;

/// Writes a file only the user may read, in a folder only the user may open.
pub(crate) fn write_secret(path: &Path, content: &[u8]) -> Result<(), Error> {
    if let Some(dir) = path.parent() {
        eos_platform::create_private_dir(dir).map_err(|e| Error::io(dir, e))?;
    }
    let options = WriteOptions::with_permissions(eos_platform::host().private_file_permissions());
    Ok(atomic_write(path, content, &options)?)
}

/// `bytes` random bytes as unpadded base64url: the shape of every secret
/// peering mints (invite secrets, relay bearers, room ids).
pub(crate) fn random_secret(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // The system's random source does not fail on the systems Eos runs on,
    // and a predictable secret must never be handed out instead.
    if let Err(e) = getrandom::fill(&mut buf) {
        panic!("the system's random source failed: {e}");
    }
    URL_SAFE_NO_PAD.encode(buf)
}

/// One of the JSON lists. Loaded on first use and kept in memory; every
/// change rewrites the file.
pub struct JsonList<T> {
    path: PathBuf,
    key_of: fn(&T) -> &str,
    items: Mutex<Option<Vec<T>>>,
}

impl<T> std::fmt::Debug for JsonList<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonList").field("path", &self.path).finish_non_exhaustive()
    }
}

impl<T: Clone + Serialize + DeserializeOwned + Validate> JsonList<T> {
    fn new(path: PathBuf, key_of: fn(&T) -> &str) -> Self {
        Self { path, key_of, items: Mutex::new(None) }
    }

    fn read(&self) -> Vec<T> {
        let Ok(raw) = std::fs::read(&self.path) else { return Vec::new() };
        let entries = match serde_json::from_slice::<serde_json::Value>(&raw) {
            Ok(serde_json::Value::Array(entries)) => entries,
            Ok(_) => Vec::new(),
            Err(e) => {
                tracing::warn!(path = %self.path.display(), error = %e, "a peering list is not JSON; read as empty");
                Vec::new()
            }
        };
        let mut items: Vec<T> = Vec::with_capacity(entries.len());
        // An entry that no longer parses is dropped rather than sinking the
        // list; a repeated key keeps its first place and its last value.
        for entry in &entries {
            let Ok(item) = eos_contracts::parse::<T>(entry) else { continue };
            match items.iter().position(|have| (self.key_of)(have) == (self.key_of)(&item)) {
                Some(at) => items[at] = item,
                None => items.push(item),
            }
        }
        items
    }

    fn with<R>(&self, f: impl FnOnce(&mut Vec<T>) -> R) -> R {
        let mut guard: MutexGuard<'_, Option<Vec<T>>> = self.items.lock().unwrap_or_else(PoisonError::into_inner);
        f(guard.get_or_insert_with(|| self.read()))
    }

    fn flush(&self, items: &[T]) {
        let mut json = serde_json::to_vec(items).unwrap_or_else(|_| b"[]".to_vec());
        json.push(b'\n');
        if let Err(e) = write_secret(&self.path, &json) {
            // The list in memory stays the truth for this run.
            tracing::error!(path = %self.path.display(), error = %e, "a peering list could not be saved");
        }
    }

    pub fn list(&self) -> Vec<T> {
        self.with(|items| items.clone())
    }

    pub fn get(&self, key: &str) -> Option<T> {
        self.with(|items| items.iter().find(|i| (self.key_of)(i) == key).cloned())
    }

    /// Replaces the item with the same key in place, or appends.
    pub fn upsert(&self, item: T) {
        self.with(|items| {
            match items.iter().position(|have| (self.key_of)(have) == (self.key_of)(&item)) {
                Some(at) => items[at] = item,
                None => items.push(item),
            }
            self.flush(items);
        });
    }

    pub fn remove(&self, key: &str) -> bool {
        self.with(|items| {
            let before = items.len();
            items.retain(|i| (self.key_of)(i) != key);
            let removed = items.len() != before;
            if removed {
                self.flush(items);
            }
            removed
        })
    }
}

pub type PairedDevices = JsonList<PairedDevice>;
pub type OpenInviteList = JsonList<OpenInvite>;
pub type KnownHosts = JsonList<KnownHost>;

pub fn paired_devices(peer_dir: &Path) -> PairedDevices {
    JsonList::new(peer_dir.join("devices.json"), |d| &d.fp.0)
}

pub fn open_invites(peer_dir: &Path) -> OpenInviteList {
    JsonList::new(peer_dir.join("invites.json"), |i| &i.hash)
}

pub fn known_hosts(peer_dir: &Path) -> KnownHosts {
    JsonList::new(peer_dir.join("hosts.json"), |h| &h.id.0)
}

/// This computer's peering room on a relay: a routing id and the owner
/// secret that pins the room to it. Apart from the phone's room, so the two
/// never evict each other's devices. Minted on first use.
pub fn load_or_create_relay_room(peer_dir: &Path) -> Result<(String, String), Error> {
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Room {
        room: String,
        owner: String,
    }
    let path = peer_dir.join("relay-room.json");
    if let Ok(raw) = std::fs::read(&path)
        && let Ok(Room { room, owner }) = serde_json::from_slice(&raw)
    {
        return Ok((room, owner));
    }
    let created = Room { room: random_secret(32), owner: random_secret(32) };
    let mut json = serde_json::to_vec(&created).unwrap_or_default();
    json.push(b'\n');
    write_secret(&path, &json)?;
    Ok((created.room, created.owner))
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_contracts::Fingerprint;
    use eos_testkit::TempHome;

    fn device(fp: &str, name: &str) -> PairedDevice {
        PairedDevice {
            fp: Fingerprint(fp.repeat(64)),
            name: name.into(),
            platform: "darwin".into(),
            paired_at: 1_800_000_000_000_i64.into(),
            last_seen_at: None,
            relay_bearer_hash: None,
        }
    }

    #[test]
    fn a_list_keeps_order_replaces_in_place_and_survives_a_reload() {
        let home = TempHome::new();
        let dir = home.join("peer");
        let devices = paired_devices(&dir);
        assert!(devices.list().is_empty());
        devices.upsert(device("a", "Laptop"));
        devices.upsert(device("b", "Studio"));
        devices.upsert(device("a", "Laptop (renamed)"));
        assert_eq!(devices.list().iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["Laptop (renamed)", "Studio"]);
        assert_eq!(devices.get(&"b".repeat(64)).map(|d| d.name), Some("Studio".into()));

        let again = paired_devices(&dir);
        assert_eq!(again.list(), devices.list());
        assert!(again.remove(&"a".repeat(64)));
        assert!(!again.remove(&"a".repeat(64)));
        assert_eq!(paired_devices(&dir).list().len(), 1);
    }

    #[test]
    fn the_file_is_compact_json_with_a_newline_readable_by_the_user_only() {
        let home = TempHome::new();
        let dir = home.join("peer");
        paired_devices(&dir).upsert(device("a", "Laptop"));
        let text = home.read("peer/devices.json");
        assert_eq!(
            text,
            format!(
                "[{{\"fp\":\"{}\",\"name\":\"Laptop\",\"platform\":\"darwin\",\"pairedAt\":1800000000000,\"lastSeenAt\":null}}]\n",
                "a".repeat(64)
            )
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).expect("exists").permissions().mode() & 0o777;
            assert_eq!(mode(&dir.join("devices.json")), 0o600);
            assert_eq!(mode(&dir), 0o700);
        }
    }

    #[test]
    fn an_entry_that_no_longer_parses_is_dropped_and_the_rest_kept() {
        let home = TempHome::new();
        let good = serde_json::to_value(device("a", "Laptop")).expect("json");
        home.write("peer/devices.json", format!("[{{\"fp\":\"short\",\"name\":1}},{good},\"junk\"]\n"));
        assert_eq!(paired_devices(&home.join("peer")).list(), [device("a", "Laptop")]);
        home.write("peer/hosts.json", "{not json");
        assert!(known_hosts(&home.join("peer")).list().is_empty());
    }

    #[test]
    fn the_relay_room_is_minted_once() {
        let home = TempHome::new();
        let dir = home.join("peer");
        let (room, owner) = load_or_create_relay_room(&dir).expect("minted");
        assert_eq!((room.len(), owner.len()), (43, 43), "32 bytes as unpadded base64url");
        assert_ne!(room, owner);
        assert_eq!(load_or_create_relay_room(&dir).expect("kept"), (room.clone(), owner.clone()));
        assert_eq!(home.read("peer/relay-room.json"), format!("{{\"room\":\"{room}\",\"owner\":\"{owner}\"}}\n"));
    }
}
