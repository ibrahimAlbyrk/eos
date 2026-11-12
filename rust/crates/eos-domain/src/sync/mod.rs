//! Sync between the user's computers: the record model, the sync key and
//! what is derived from it, and the content fingerprint
//! (`core/src/domain/sync.ts`, `infra/src/sync/sync-key.ts`).
//!
//! A record is one piece of user data (`<domain>/<id>`) in its portable form.
//! It carries no sync fields: this computer's [`LocalState`] remembers, per
//! record, the vault sequence number it last matched and the fingerprint of
//! the local record at that moment. A fingerprint that differs later is a
//! local change to push.
//!
//! Wire formats here are shared with other computers and must not drift:
//!
//! ```text
//! key      = "eos-sync1." base64url(relayUrl) "." base64url(32-byte secret)
//! derive   = HKDF-SHA256(ikm = secret, salt = "eos-sync-v1", info = label)
//!            labels: "enc" (32), "record-key" (32), "vault-id" (16), "auth" (32)
//! name     = hex(HMAC-SHA256(record-key, domain ‖ 0x00 ‖ id))
//! record   = nonce(12) ‖ AES-256-GCM(enc, nonce, aad = name as ASCII) ‖ tag(16)
//! content  = the envelope (v1) as JSON
//! hash     = hex(SHA-256(stable_stringify(data)))        (this computer only)
//! ```

pub mod key;
pub mod stable;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use key::{OpenError, SyncIdentity, SyncKeys, content_hash, format_sync_key, parse_sync_key};
pub use stable::stable_stringify;

/// One record as its domain hands it over and takes it back.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncItem {
    pub id: String,
    pub data: Value,
    /// When the record last changed here, in epoch milliseconds, if the
    /// domain knows; decides conflicts.
    pub updated_at: Option<f64>,
}

/// What this computer remembers of one record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub seq: u64,
    /// `None`: the record is deleted (a tombstone in the vault).
    pub hash: Option<String>,
}

/// This computer's sync bookkeeping (`sync/state.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalState {
    /// The last vault sequence number seen.
    pub cursor: u64,
    /// Keyed [`index_key`].
    pub index: IndexMap<String, IndexEntry>,
}

/// `<domain>/<id>`: a record's key in the index.
pub fn index_key(domain: &str, id: &str) -> String {
    format!("{domain}/{id}")
}

/// The fingerprint of a record's content: equal content gives an equal
/// fingerprint on every computer, whatever the key order.
pub fn data_hash(data: &Value) -> String {
    content_hash(&stable_stringify(data))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_state_file_reads_and_writes_as_today() {
        let text = r#"{"cursor":7,"index":{"memory/um-1":{"seq":7,"hash":"h"},"page/pg-1":{"seq":3,"hash":null}}}"#;
        let state: LocalState = serde_json::from_str(text).unwrap();
        assert_eq!(state.cursor, 7);
        assert_eq!(state.index["page/pg-1"], IndexEntry { seq: 3, hash: None });
        assert_eq!(serde_json::to_string(&state).unwrap(), text);
    }

    #[test]
    fn the_fingerprint_ignores_key_order() {
        assert_eq!(data_hash(&json!({ "a": 1, "b": [1, 2] })), data_hash(&json!({ "b": [1, 2], "a": 1.0 })));
        assert_ne!(data_hash(&json!({ "a": 1 })), data_hash(&json!({ "a": 2 })));
        assert_eq!(index_key("memory", "um-1"), "memory/um-1");
    }
}
