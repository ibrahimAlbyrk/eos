//! `<home>/remote`: the phone link's secrets and its audit log, in today's
//! files:
//!
//! ```text
//! room.id              base64url of 32 random bytes + "\n"   (user only)
//! bearer.secret        the same shape                        (user only)
//! relay-owner.secret   the same shape                        (user only)
//! remote-audit.log     one JSON object per line, appended
//! remote-audit.log.1   the log before, once the log reached its size
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

/// How big the audit log grows (about 40,000 phone requests) before it
/// becomes `remote-audit.log.1`, replacing the one there.
pub const AUDIT_LOG_MAX: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
struct OpenLog {
    file: File,
    size: u64,
}

#[derive(Debug)]
pub struct RemoteFiles {
    dir: PathBuf,
    log: Mutex<Option<OpenLog>>,
    log_max: u64,
}

impl RemoteFiles {
    /// Over `<home>/remote`. Nothing is created until it is used.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into(), log: Mutex::new(None), log_max: AUDIT_LOG_MAX }
    }

    fn log(&self) -> MutexGuard<'_, Option<OpenLog>> {
        // Holds an open file or nothing: valid after any panic.
        self.log.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn open_log(&self) -> Result<OpenLog, Error> {
        fs::create_dir_all(&self.dir).map_err(Error::storage)?;
        let path = self.dir.join("remote-audit.log");
        let file = OpenOptions::new().create(true).append(true).open(path).map_err(Error::storage)?;
        let size = file.metadata().map_err(Error::storage)?.len();
        Ok(OpenLog { file, size })
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
        let mut open = match log.take() {
            Some(open) => open,
            None => self.open_log()?,
        };
        // A line never splits across the two files.
        if open.size > 0 && open.size + line.len() as u64 > self.log_max {
            drop(open);
            let path = self.dir.join("remote-audit.log");
            fs::rename(&path, path.with_extension("log.1")).map_err(Error::storage)?;
            open = self.open_log()?;
        }
        // One write per line: lines of concurrent appends never mix.
        let written = open.file.write_all(&line).map_err(Error::storage);
        if written.is_ok() {
            open.size += line.len() as u64;
        }
        *log = Some(open);
        written
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

    #[test]
    fn the_audit_log_starts_over_at_its_size_and_keeps_the_one_before() {
        let home = tempfile::tempdir().expect("a folder");
        let dir = home.path().join("remote");
        let line = |n: u32| RemoteAuditEntry {
            device: "d".into(),
            action: format!("POST /pty/p-{n}/input"),
            target: "/pty".into(),
            ts: 1,
            result: RemoteAuditResult::Ok,
        };
        let one = serde_json::to_vec(&line(1)).expect("json").len() as u64 + 1;
        // Room for three lines a file.
        let files = RemoteFiles { dir: dir.clone(), log: Mutex::new(None), log_max: one * 3 };
        for n in 1..=8 {
            files.audit(&line(n)).expect("appended");
        }
        let read = |name: &str| fs::read_to_string(dir.join(name)).expect("a log");
        let actions = |text: String| -> Vec<String> {
            text.lines()
                .map(|l| serde_json::from_str::<serde_json::Value>(l).expect("a line")["action"].to_string())
                .collect()
        };
        assert_eq!(actions(read("remote-audit.log")), ["\"POST /pty/p-7/input\"", "\"POST /pty/p-8/input\""]);
        assert_eq!(actions(read("remote-audit.log.1")).len(), 3, "only the one before is kept");
        assert!(!dir.join("remote-audit.log.2").exists());

        // A log that was already full when the app started is rotated on its first line.
        let again = RemoteFiles { dir: dir.clone(), log: Mutex::new(None), log_max: one * 2 };
        again.audit(&line(9)).expect("appended");
        assert_eq!(actions(read("remote-audit.log")), ["\"POST /pty/p-9/input\""]);
        assert_eq!(actions(read("remote-audit.log.1")).len(), 2);
    }
}
