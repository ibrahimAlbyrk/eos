//! The relay's rooms, as `relay/RoomRegistry.ts` and `relay/admission.ts`
//! keep them: who owns a room, who may join, where a frame goes.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bytes::Bytes;
use eos_core::net::relay::RelayClientId;
use sha2::{Digest, Sha256};

/// One connection to the relay, as the registry sees it.
pub trait RelaySocket: Send + Sync {
    fn send(&self, data: Bytes);
    fn close(&self);
}

pub type SocketRef = Arc<dyn RelaySocket>;

fn key(socket: &SocketRef) -> usize {
    Arc::as_ptr(socket).cast::<()>() as usize
}

fn same(a: &SocketRef, b: &SocketRef) -> bool {
    key(a) == key(b)
}

pub fn sha256_hex(input: impl AsRef<[u8]>) -> String {
    Sha256::digest(input.as_ref()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn owner_hash_matches(presented_owner: &str, stored_hash: &str) -> bool {
    sha256_hex(presented_owner) == stored_hash
}

pub fn bearer_allowed(presented_bearer: &str, allow: &HashSet<String>) -> bool {
    allow.contains(&sha256_hex(presented_bearer))
}

/// The relay's error codes (`relay/errors.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayErrorCode {
    RoomNotFound,
    BearerDenied,
    OwnerMismatch,
    RoomFull,
    FrameTooLarge,
    BadRequest,
}

impl RelayErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RoomNotFound => "ROOM_NOT_FOUND",
            Self::BearerDenied => "BEARER_DENIED",
            Self::OwnerMismatch => "OWNER_MISMATCH",
            Self::RoomFull => "ROOM_FULL",
            Self::FrameTooLarge => "FRAME_TOO_LARGE",
            Self::BadRequest => "BAD_REQUEST",
        }
    }
}

struct Room {
    owner_hash: String,
    mac: Option<SocketRef>,
    allow: HashSet<String>,
    devices: HashMap<RelayClientId, SocketRef>,
}

enum ConnMeta {
    Mac { room: String },
    Device { room: String, client: RelayClientId },
}

/// What the server announces after a connection dropped.
pub enum Dropped {
    Device { room: String, client: RelayClientId, mac: Option<SocketRef> },
    Mac { room: String },
}

impl std::fmt::Debug for Dropped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Device { room, client, mac } => {
                write!(f, "Device {{ room: {room}, client: {client:02x?}, mac: {} }}", mac.is_some())
            }
            Self::Mac { room } => write!(f, "Mac {{ room: {room} }}"),
        }
    }
}

pub struct RoomRegistry {
    rooms: HashMap<String, Room>,
    meta: HashMap<usize, ConnMeta>,
    owner_hash_pin: Option<String>,
    max_room_devices: usize,
    next_client: Box<dyn FnMut() -> RelayClientId + Send>,
}

impl std::fmt::Debug for RoomRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoomRegistry").field("rooms", &self.rooms.len()).finish_non_exhaustive()
    }
}

impl Default for RoomRegistry {
    fn default() -> Self {
        Self::new(None, 32)
    }
}

fn lower(allow: &[String]) -> HashSet<String> {
    allow.iter().map(|h| h.to_lowercase()).collect()
}

impl RoomRegistry {
    pub fn new(owner_hash_pin: Option<String>, max_room_devices: usize) -> Self {
        // Ids that differ and are easy to read in a failing test; the real
        // relay draws 16 random bytes.
        let mut n: u128 = 0;
        let next_client = Box::new(move || {
            n += 1;
            (0xc0de_0000_0000_0000_0000_0000_0000_0000u128 + n).to_be_bytes()
        });
        Self { rooms: HashMap::new(), meta: HashMap::new(), owner_hash_pin, max_room_devices, next_client }
    }

    /// The owner claims a room. The first valid registration pins the owner's
    /// hash; a later one replaces the owner's socket and the admission list,
    /// and closes the devices that joined through another, still open socket.
    pub fn register(
        &mut self,
        room: &str,
        owner_bearer: &str,
        allow: &[String],
        socket: &SocketRef,
    ) -> Result<bool, RelayErrorCode> {
        if let Some(existing) = self.rooms.get_mut(room) {
            if !owner_hash_matches(owner_bearer, &existing.owner_hash) {
                return Err(RelayErrorCode::OwnerMismatch);
            }
            if existing.mac.as_ref().is_some_and(|mac| !same(mac, socket)) {
                Self::evict_devices(&mut self.meta, existing);
            }
            existing.mac = Some(socket.clone());
            existing.allow = lower(allow);
            self.meta.insert(key(socket), ConnMeta::Mac { room: room.to_owned() });
            return Ok(true);
        }
        let owner_hash = sha256_hex(owner_bearer);
        if self.owner_hash_pin.as_ref().is_some_and(|pin| *pin != owner_hash) {
            return Err(RelayErrorCode::OwnerMismatch);
        }
        self.rooms.insert(
            room.to_owned(),
            Room { owner_hash, mac: Some(socket.clone()), allow: lower(allow), devices: HashMap::new() },
        );
        self.meta.insert(key(socket), ConnMeta::Mac { room: room.to_owned() });
        Ok(false)
    }

    /// A device asks in. On success: its id, and the owner's socket to notify.
    pub fn join(
        &mut self,
        room: &str,
        bearer: &str,
        socket: &SocketRef,
    ) -> Result<(RelayClientId, SocketRef), RelayErrorCode> {
        let found = self.rooms.get_mut(room).ok_or(RelayErrorCode::RoomNotFound)?;
        let mac = found.mac.clone().ok_or(RelayErrorCode::RoomNotFound)?;
        if !bearer_allowed(bearer, &found.allow) {
            return Err(RelayErrorCode::BearerDenied);
        }
        if found.devices.len() >= self.max_room_devices {
            return Err(RelayErrorCode::RoomFull);
        }
        let client = (self.next_client)();
        found.devices.insert(client, socket.clone());
        self.meta.insert(key(socket), ConnMeta::Device { room: room.to_owned(), client });
        Ok((client, mac))
    }

    /// Only the room's owner, on its current socket, changes who may join.
    pub fn update_allow(&mut self, room: &str, add: bool, hash: &str, from: &SocketRef) -> Result<(), RelayErrorCode> {
        let is_owner = matches!(self.meta.get(&key(from)), Some(ConnMeta::Mac { room: own }) if own == room);
        let found = self.rooms.get_mut(room).filter(|r| is_owner && r.mac.as_ref().is_some_and(|mac| same(mac, from)));
        let Some(found) = found else { return Err(RelayErrorCode::OwnerMismatch) };
        if add {
            found.allow.insert(hash.to_lowercase());
        } else {
            found.allow.remove(&hash.to_lowercase());
        }
        Ok(())
    }

    /// Forwards a data frame as it is: device → owner (`dir` 0), owner → the
    /// addressed device (anything else).
    pub fn route_data(&self, room: &str, dir: u8, client: &RelayClientId, raw: Bytes) -> Result<(), RelayErrorCode> {
        let found = self.rooms.get(room).ok_or(RelayErrorCode::RoomNotFound)?;
        let target = if dir == 0x00 { found.mac.as_ref() } else { found.devices.get(client) };
        target.ok_or(RelayErrorCode::RoomNotFound)?.send(raw);
        Ok(())
    }

    /// A connection closed. A dropped owner leaves the room and its admission
    /// list for a reconnect but closes its devices; a dropped device is taken
    /// out of routing and reported, so the owner can be told.
    pub fn drop_socket(&mut self, socket: &SocketRef) -> Option<Dropped> {
        let meta = self.meta.remove(&key(socket))?;
        match meta {
            ConnMeta::Mac { room } => {
                let found = self.rooms.get_mut(&room)?;
                if !found.mac.as_ref().is_some_and(|mac| same(mac, socket)) {
                    return None;
                }
                found.mac = None;
                Self::evict_devices(&mut self.meta, found);
                Some(Dropped::Mac { room })
            }
            ConnMeta::Device { room, client } => {
                let found = self.rooms.get_mut(&room)?;
                if !found.devices.get(&client).is_some_and(|device| same(device, socket)) {
                    return None;
                }
                found.devices.remove(&client);
                Some(Dropped::Device { room, client, mac: found.mac.clone() })
            }
        }
    }

    // Their records go first, so the close that follows reports nothing: no
    // "left" is sent for a device the new owner socket never knew.
    fn evict_devices(meta: &mut HashMap<usize, ConnMeta>, room: &mut Room) {
        for (_, socket) in room.devices.drain() {
            meta.remove(&key(&socket));
            socket.close();
        }
    }

    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    /// Devices joined to `room` right now.
    pub fn device_count(&self, room: &str) -> usize {
        self.rooms.get(room).map_or(0, |r| r.devices.len())
    }
}

#[cfg(test)]
mod tests {
    //! `relay/__tests__/registry.test.ts` and `admission.test.ts`.

    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    #[derive(Default)]
    struct Fake {
        sent: Mutex<Vec<Bytes>>,
        closed: AtomicBool,
    }

    impl RelaySocket for Fake {
        fn send(&self, data: Bytes) {
            self.sent.lock().expect("lock").push(data);
        }
        fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    fn socket() -> (Arc<Fake>, SocketRef) {
        let fake = Arc::new(Fake::default());
        (fake.clone(), fake)
    }

    const ROOM: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    fn allow(bearers: &[&str]) -> Vec<String> {
        bearers.iter().map(sha256_hex).collect()
    }

    #[test]
    fn register_pins_the_owner_and_a_later_one_replaces_the_socket() {
        let mut reg = RoomRegistry::default();
        assert_eq!(reg.register(ROOM, "owner-secret", &[], &socket().1), Ok(false));
        assert_eq!(reg.register(ROOM, "owner-secret", &[], &socket().1), Ok(true));
        assert_eq!(reg.register(ROOM, "wrong-owner", &[], &socket().1), Err(RelayErrorCode::OwnerMismatch));
    }

    #[test]
    fn an_operator_pin_rejects_another_owner() {
        let mut reg = RoomRegistry::new(Some(sha256_hex("the-owner")), 32);
        assert_eq!(reg.register(ROOM, "the-owner", &[], &socket().1), Ok(false));
        let mut reg = RoomRegistry::new(Some(sha256_hex("the-owner")), 32);
        assert_eq!(reg.register(ROOM, "impostor", &[], &socket().1), Err(RelayErrorCode::OwnerMismatch));
    }

    #[test]
    fn join_admits_a_listed_bearer_and_names_the_device() {
        let mut reg = RoomRegistry::default();
        let (_, mac) = socket();
        reg.register(ROOM, "owner", &allow(&["dev-bearer"]), &mac).expect("registers");
        let (client, notify) = reg.join(ROOM, "dev-bearer", &socket().1).expect("joins");
        assert_eq!(client.len(), 16);
        assert!(same(&notify, &mac));
    }

    #[test]
    fn join_denies_an_unknown_bearer_an_unknown_room_and_a_full_room() {
        let mut reg = RoomRegistry::new(None, 1);
        reg.register(ROOM, "owner", &allow(&["dev-bearer"]), &socket().1).expect("registers");
        assert_eq!(reg.join(ROOM, "stranger", &socket().1).err(), Some(RelayErrorCode::BearerDenied));
        assert_eq!(reg.join("ZZZ", "dev-bearer", &socket().1).err(), Some(RelayErrorCode::RoomNotFound));
        reg.join(ROOM, "dev-bearer", &socket().1).expect("the first fits");
        assert_eq!(reg.join(ROOM, "dev-bearer", &socket().1).err(), Some(RelayErrorCode::RoomFull));
    }

    #[test]
    fn only_the_owner_changes_who_may_join() {
        let mut reg = RoomRegistry::default();
        let (_, mac) = socket();
        reg.register(ROOM, "owner", &[], &mac).expect("registers");
        assert_eq!(reg.update_allow(ROOM, true, &sha256_hex("new-dev"), &mac), Ok(()));
        assert_eq!(reg.update_allow(ROOM, true, &sha256_hex("x"), &socket().1), Err(RelayErrorCode::OwnerMismatch));
        assert!(reg.join(ROOM, "new-dev", &socket().1).is_ok());
        assert_eq!(reg.update_allow(ROOM, false, &sha256_hex("new-dev"), &mac), Ok(()));
        assert_eq!(reg.join(ROOM, "new-dev", &socket().1).err(), Some(RelayErrorCode::BearerDenied));
    }

    #[test]
    fn data_goes_up_to_the_owner_and_down_to_the_addressed_device() {
        let mut reg = RoomRegistry::default();
        let (mac_fake, mac) = socket();
        reg.register(ROOM, "owner", &allow(&["dev"]), &mac).expect("registers");
        let (dev_fake, dev) = socket();
        let (client, _) = reg.join(ROOM, "dev", &dev).expect("joins");

        assert_eq!(reg.route_data(ROOM, 0x00, &client, Bytes::from_static(b"c2s-frame")), Ok(()));
        assert_eq!(mac_fake.sent.lock().expect("lock").last().map(|b| &b[..]), Some(&b"c2s-frame"[..]));
        assert_eq!(reg.route_data(ROOM, 0x01, &client, Bytes::from_static(b"s2c-frame")), Ok(()));
        assert_eq!(dev_fake.sent.lock().expect("lock").last().map(|b| &b[..]), Some(&b"s2c-frame"[..]));
    }

    #[test]
    fn a_dropped_device_leaves_routing_and_a_dropped_owner_keeps_the_room() {
        let mut reg = RoomRegistry::default();
        let (_, mac) = socket();
        reg.register(ROOM, "owner", &allow(&["dev"]), &mac).expect("registers");
        let (_, dev) = socket();
        let (client, _) = reg.join(ROOM, "dev", &dev).expect("joins");

        match reg.drop_socket(&dev) {
            Some(Dropped::Device { client: gone, mac: Some(notify), .. }) => {
                assert_eq!(gone, client);
                assert!(same(&notify, &mac));
            }
            other => panic!("expected the device, got {other:?}"),
        }
        assert_eq!(reg.route_data(ROOM, 0x01, &client, Bytes::from_static(b"x")), Err(RelayErrorCode::RoomNotFound));

        assert!(matches!(reg.drop_socket(&mac), Some(Dropped::Mac { .. })));
        assert_eq!(reg.room_count(), 1, "the room survives for the owner's reconnect");
        assert_eq!(reg.join(ROOM, "dev", &socket().1).err(), Some(RelayErrorCode::RoomNotFound));
    }

    #[test]
    fn a_dropped_owner_closes_its_devices_and_the_admission_list_survives() {
        let mut reg = RoomRegistry::default();
        let (_, mac) = socket();
        reg.register(ROOM, "owner", &allow(&["dev"]), &mac).expect("registers");
        let (dev_fake, dev) = socket();
        reg.join(ROOM, "dev", &dev).expect("joins");

        assert!(matches!(reg.drop_socket(&mac), Some(Dropped::Mac { room }) if room == ROOM));
        assert!(dev_fake.closed.load(Ordering::SeqCst));
        assert!(reg.drop_socket(&dev).is_none(), "the evicted device's own close tells nobody");
        reg.register(ROOM, "owner", &allow(&["dev"]), &socket().1).expect("registers again");
        assert!(reg.join(ROOM, "dev", &socket().1).is_ok());
    }

    #[test]
    fn registering_from_another_socket_closes_the_old_sessions_devices() {
        let mut reg = RoomRegistry::default();
        let (_, mac1) = socket();
        reg.register(ROOM, "owner", &allow(&["dev"]), &mac1).expect("registers");
        let (dev_fake, dev) = socket();
        let (client, _) = reg.join(ROOM, "dev", &dev).expect("joins");

        reg.register(ROOM, "owner", &allow(&["dev"]), &socket().1).expect("registers again");
        assert!(dev_fake.closed.load(Ordering::SeqCst));
        assert_eq!(reg.route_data(ROOM, 0x01, &client, Bytes::from_static(b"x")), Err(RelayErrorCode::RoomNotFound));
        assert!(reg.drop_socket(&mac1).is_none(), "the stale owner socket closing later orphans nothing");
        assert!(reg.join(ROOM, "dev", &socket().1).is_ok());
    }

    #[test]
    fn admission_compares_hashes() {
        assert_eq!(sha256_hex("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert!(owner_hash_matches("owner-secret", &sha256_hex("owner-secret")));
        assert!(!owner_hash_matches("not-it", &sha256_hex("owner-secret")));
        let allow: HashSet<String> = [sha256_hex("dev-A"), sha256_hex("dev-B")].into();
        assert!(bearer_allowed("dev-A", &allow) && bearer_allowed("dev-B", &allow));
        assert!(!bearer_allowed("dev-C", &allow));
        assert!(!bearer_allowed("anything", &HashSet::new()));
    }
}
