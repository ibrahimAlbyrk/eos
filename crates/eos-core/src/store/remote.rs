//! The phone link's own files, under `<home>/remote`.

use serde::Serialize;

use crate::Error;

/// What reaching this computer's room takes. Minted once and kept, so every
/// reconnect uses the same room and a paired phone stays paired.
#[derive(Clone, PartialEq, Eq)]
pub struct RoomSecrets {
    /// `room.id`: the routing key, and a capability by being unguessable.
    pub room: String,
    /// `bearer.secret`: what a phone presents to join. The relay is given
    /// only its hash.
    pub bearer: String,
    /// `relay-owner.secret`: proves to the relay that the room is this computer's.
    pub owner: String,
}

impl std::fmt::Debug for RoomSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RoomSecrets")
    }
}

/// This computer's hook inbox on the relay (`hooks.json`): minted once and
/// kept, so the hooks outside services hold keep reaching it.
#[derive(Clone, PartialEq, Eq)]
pub struct HookIdentity {
    /// 32 hex characters: the inbox's id on the relay.
    pub inbox: String,
    /// What proves the inbox is this computer's. The relay keeps its hash.
    pub bearer: String,
    /// The X25519 secret the relay's sealed events open with.
    pub secret_key: [u8; 32],
}

impl std::fmt::Debug for HookIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HookIdentity")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteAuditResult {
    Ok,
    Denied,
    Error,
}

/// One request a phone made, as the audit log keeps it (one JSON line, the
/// fields in this order).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteAuditEntry {
    /// The device: its relay id, in hex.
    pub device: String,
    /// The method and the path as sent, e.g. `DELETE /workers/abc`.
    pub action: String,
    /// The path as sent.
    pub target: String,
    pub ts: i64,
    pub result: RemoteAuditResult,
}

pub trait RemoteStore: Send + Sync + 'static {
    /// The room's secrets; what is missing is minted and written, readable
    /// by the user only.
    fn secrets(&self) -> Result<RoomSecrets, Error>;
    /// The room's secrets as written, `None` while any is missing: nothing is
    /// minted, so asking leaves no trace of a link that was never set up.
    fn saved_secrets(&self) -> Result<Option<RoomSecrets>, Error>;
    /// The hook inbox's identity; minted and written, readable by the user
    /// only, the first time it is asked for.
    fn hook_identity(&self) -> Result<HookIdentity, Error>;
    /// Appends to `remote-audit.log`. The log is only ever appended to.
    fn audit(&self, entry: &RemoteAuditEntry) -> Result<(), Error>;
}
