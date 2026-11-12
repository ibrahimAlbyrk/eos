//! `<home>/remote`: the phone link's secrets and its audit log, in today's
//! files (`manager/remote/keyring.ts`, `audit.ts`):
//!
//! ```text
//! room.id              base64url of 32 random bytes + "\n"   (user only)
//! bearer.secret        the same shape                        (user only)
//! relay-owner.secret   the same shape                        (user only)
//! remote-audit.log     one JSON object per line, appended
//! ```

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use eos_core::Error;
use eos_core::store::{RemoteAuditEntry, RemoteStore, RoomSecrets};
use eos_kit_fs::{WriteOptions, atomic_write};

#[derive(Debug)]
pub struct RemoteFiles {
    dir: PathBuf,
    log: Mutex<Option<File>>,
}

impl RemoteFiles {
    /// Over `<home>/remote`. Nothing is created until it is used.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), log: Mutex::new(None) }
    }

    fn log(&self) -> MutexGuard<'_, Option<File>> {
        // Holds an open file or nothing: valid after any panic.
        self.log.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn mint() -> Result<String, Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(Error::storage)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The secret in `path`, or a fresh one written there.
fn load_or_mint(path: &Path) -> Result<String, Error> {
    match fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => return Ok(text.trim().to_owned()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(Error::storage(format!("{}: {e}", path.display()))),
    }
    let secret = mint()?;
    let options = WriteOptions::with_permissions(eos_platform::host().private_file_permissions());
    atomic_write(path, format!("{secret}\n").as_bytes(), &options).map_err(Error::storage)?;
    Ok(secret)
}

impl RemoteStore for RemoteFiles {
    fn secrets(&self) -> Result<RoomSecrets, Error> {
        fs::create_dir_all(&self.dir).map_err(|e| Error::storage(format!("{}: {e}", self.dir.display())))?;
        Ok(RoomSecrets {
            room: load_or_mint(&self.dir.join("room.id"))?,
            bearer: load_or_mint(&self.dir.join("bearer.secret"))?,
            owner: load_or_mint(&self.dir.join("relay-owner.secret"))?,
        })
    }

    fn audit(&self, entry: &RemoteAuditEntry) -> Result<(), Error> {
        let mut line = serde_json::to_vec(entry).map_err(Error::storage)?;
        line.push(b'\n');
        let mut log = self.log();
        if log.is_none() {
            fs::create_dir_all(&self.dir).map_err(Error::storage)?;
            let path = self.dir.join("remote-audit.log");
            *log = Some(OpenOptions::new().create(true).append(true).open(path).map_err(Error::storage)?);
        }
        match log.as_mut() {
            // One write per line: lines of concurrent appends never mix.
            Some(file) => file.write_all(&line).map_err(Error::storage),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use eos_core::store::RemoteAuditResult;

    use super::*;

    #[test]
    fn mints_the_secrets_once_and_keeps_them_private() {
        let home = tempfile::tempdir().expect("a folder");
        let dir = home.path().join("remote");
        let first = RemoteFiles::new(&dir).secrets().expect("minted");
        for secret in [&first.room, &first.bearer, &first.owner] {
            assert_eq!(secret.len(), 43, "32 bytes as unpadded base64url");
            assert!(secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        }
        assert!(first.room != first.bearer && first.bearer != first.owner);
        assert_eq!(fs::read_to_string(dir.join("room.id")).expect("written"), format!("{}\n", first.room));

        assert_eq!(RemoteFiles::new(&dir).secrets().expect("loaded"), first, "a restart keeps the room");

        #[cfg(unix)]
        for name in ["room.id", "bearer.secret", "relay-owner.secret"] {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(name)).expect("there").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{name}");
        }
    }

    #[test]
    fn reads_what_todays_app_wrote_and_replaces_an_empty_file() {
        let home = tempfile::tempdir().expect("a folder");
        fs::write(home.path().join("room.id"), "ROOM-FROM-BEFORE\n").expect("written");
        fs::write(home.path().join("bearer.secret"), "  \n").expect("written");
        let secrets = RemoteFiles::new(home.path()).secrets().expect("loaded");
        assert_eq!(secrets.room, "ROOM-FROM-BEFORE");
        assert_eq!(secrets.bearer.len(), 43);
    }

    #[test]
    fn the_audit_log_is_one_json_line_per_request_in_todays_field_order() {
        let home = tempfile::tempdir().expect("a folder");
        let files = RemoteFiles::new(home.path().join("remote"));
        let entry = |action: &str, result| RemoteAuditEntry {
            device: "a1".repeat(16),
            action: action.to_owned(),
            target: "/workers".to_owned(),
            ts: 1_731_400_000_000,
            result,
        };
        files.audit(&entry("GET /workers", RemoteAuditResult::Ok)).expect("appended");
        files.audit(&entry("POST /workers", RemoteAuditResult::Denied)).expect("appended");
        let text = fs::read_to_string(home.path().join("remote/remote-audit.log")).expect("the log");
        let device = "a1".repeat(16);
        assert_eq!(
            text,
            format!(
                "{{\"device\":\"{device}\",\"action\":\"GET /workers\",\"target\":\"/workers\",\"ts\":1731400000000,\"result\":\"ok\"}}\n\
                 {{\"device\":\"{device}\",\"action\":\"POST /workers\",\"target\":\"/workers\",\"ts\":1731400000000,\"result\":\"denied\"}}\n"
            )
        );
    }
}
