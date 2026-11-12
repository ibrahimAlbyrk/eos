//! The phone link's own files, under `<home>/remote`
//! (`manager/remote/keyring.ts`, `audit.ts`, `wire.ts`).

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
    /// Appends to `remote-audit.log`. The log is only ever appended to.
    fn audit(&self, entry: &RemoteAuditEntry) -> Result<(), Error>;
}
