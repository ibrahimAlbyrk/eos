//! Sync files under `<data folder>/sync` (`infra/src/sync/stores.ts`):
//!
//! ```text
//! identity.json   relay URL + secret (owner-only)
//! state.json      vault cursor + per-record index (regenerable: a fresh index
//!                 re-reads the vault, and matching content is not a conflict)
//! conflicts/      the losing side of each conflict, <domain>/<id>.<stamp>.json
//! ```

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use eos_core::net::sync::{SyncIdentityStore, SyncStateStore};
use eos_core::{Clock, Error};
use eos_domain::sync::{LocalState, SyncIdentity};
use eos_domain::time::iso_from_ms;
use eos_kit_fs::{WriteOptions, atomic_write};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub struct FileSyncStateStore {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FileSyncStateStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileSyncStateStore").field("dir", &self.dir).finish_non_exhaustive()
    }
}

/// An id as a file name: every UTF-16 unit outside `A-Za-z0-9._-` becomes `_`.
fn safe_id(id: &str) -> String {
    id.encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(b) if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') => char::from(b),
            _ => '_',
        })
        .collect()
}

impl FileSyncStateStore {
    /// `dir` is `<data folder>/sync`.
    pub fn new(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        Self { dir: dir.into(), clock }
    }

    fn state_file(&self) -> PathBuf {
        self.dir.join("state.json")
    }

    /// `<id>.<stamp>.json`, or with `-2`, `-3`… when that name is taken: two
    /// losing versions of one record in one millisecond are both kept.
    fn conflict_file(&self, domain: &str, id: &str) -> PathBuf {
        let stamp = iso_from_ms(self.clock.now_ms()).replace([':', '.'], "-");
        let stamp = stamp.trim_end_matches('Z');
        let dir = self.dir.join("conflicts").join(safe_id(domain));
        let base = format!("{}.{stamp}", safe_id(id));
        let first = dir.join(format!("{base}.json"));
        if !first.exists() {
            return first;
        }
        (2u32..).map(|n| dir.join(format!("{base}-{n}.json"))).find(|path| !path.exists()).unwrap_or(first)
    }
}

impl SyncStateStore for FileSyncStateStore {
    fn load(&self) -> LocalState {
        fs::read(self.state_file()).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
    }

    fn save(&self, state: &LocalState) -> Result<(), Error> {
        let json = serde_json::to_vec(state).map_err(Error::storage)?;
        atomic_write(&self.state_file(), &json, &WriteOptions::default()).map_err(Error::storage)
    }

    fn save_conflict(&self, domain: &str, id: &str, data: &Value) -> Result<(), Error> {
        let json = serde_json::to_vec_pretty(data).map_err(Error::storage)?;
        atomic_write(&self.conflict_file(domain, id), &json, &WriteOptions::default()).map_err(Error::storage)
    }

    fn reset(&self) -> Result<(), Error> {
        match fs::remove_file(self.state_file()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::storage(e)),
            _ => Ok(()),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    relay_url: String,
    secret: String,
}

#[derive(Debug)]
pub struct FileSyncIdentityStore {
    path: PathBuf,
}

impl FileSyncIdentityStore {
    /// `dir` is `<data folder>/sync`.
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self { path: dir.as_ref().join("identity.json") }
    }
}

impl SyncIdentityStore for FileSyncIdentityStore {
    fn load(&self) -> Option<SyncIdentity> {
        let file: IdentityFile = serde_json::from_slice(&fs::read(&self.path).ok()?).ok()?;
        if file.relay_url.is_empty() {
            return None;
        }
        let secret = URL_SAFE_NO_PAD.decode(file.secret.trim_end_matches('=')).ok()?.try_into().ok()?;
        Some(SyncIdentity { relay_url: file.relay_url, secret })
    }

    /// Written owner-only from the first byte: the secret is the account.
    fn save(&self, identity: &SyncIdentity) -> Result<(), Error> {
        if let Some(dir) = self.path.parent() {
            eos_platform::create_private_dir(dir).map_err(Error::storage)?;
        }
        let file =
            IdentityFile { relay_url: identity.relay_url.clone(), secret: URL_SAFE_NO_PAD.encode(identity.secret) };
        let json = serde_json::to_vec(&file).map_err(Error::storage)?;
        let private = WriteOptions::with_permissions(eos_platform::host().private_file_permissions());
        atomic_write(&self.path, &json, &private).map_err(Error::storage)
    }

    fn clear(&self) -> Result<(), Error> {
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::storage(e)),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_from_another_computer_cannot_leave_the_conflicts_folder() {
        assert_eq!(safe_id("../evil"), ".._evil");
        assert_eq!(safe_id("um-1.v2_ok"), "um-1.v2_ok");
        assert_eq!(safe_id("a/b\\c d😀"), "a_b_c_d__");
    }
}
