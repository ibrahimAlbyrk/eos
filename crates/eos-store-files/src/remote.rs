//! `<home>/remote`: the phone link's secrets and its audit log, in today's
//! files:
//!
//! ```text
//! room.id              base64url of 32 random bytes + "\n"   (user only)
//! bearer.secret        the same shape                        (user only)
//! relay-owner.secret   the same shape                        (user only)
//! remote-audit.log     one JSON object per line, appended
//! remote-audit.log.1   the log before, once the log reached its size
//! hooks.json           {inbox, bearer, secretKey}: the hook inbox  (user only)
//! ```

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use eos_core::Error;
use eos_core::store::{HookIdentity, RemoteAuditEntry, RemoteStore, RoomSecrets};
use eos_kit_fs::{WriteOptions, atomic_write};
use serde::{Deserialize, Serialize};

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

fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(Error::storage)?;
    Ok(bytes)
}

fn mint() -> Result<String, Error> {
    Ok(URL_SAFE_NO_PAD.encode(random::<32>()?))
}

/// `hooks.json` as written.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookFile {
    inbox: String,
    bearer: String,
    /// Standard base64 of the 32 bytes.
    secret_key: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_hook_file(path: &Path) -> Result<Option<HookIdentity>, Error> {
    let text = match fs::read(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::storage(format!("{}: {e}", path.display()))),
    };
    // A file that does not read is never replaced: the hooks the services
    // hold name its inbox.
    let bad = || Error::storage(format!("{}: not a hook inbox identity", path.display()));
    let file: HookFile = serde_json::from_slice(&text).map_err(|_| bad())?;
    let secret_key = base64::engine::general_purpose::STANDARD.decode(&file.secret_key).map_err(|_| bad())?;
    let secret_key: [u8; 32] = secret_key.try_into().map_err(|_| bad())?;
    Ok(Some(HookIdentity { inbox: file.inbox, bearer: file.bearer, secret_key }))
}

/// The secret in `path`, or a fresh one written there.
fn load_or_mint(path: &Path) -> Result<String, Error> {
    if let Some(secret) = load(path)? {
        return Ok(secret);
    }
    let secret = mint()?;
    let options = WriteOptions::with_permissions(eos_platform::host().private_file_permissions());
    atomic_write(path, format!("{secret}\n").as_bytes(), &options).map_err(Error::storage)?;
    Ok(secret)
}

/// The secret in `path`; `None` when there is none.
fn load(path: &Path) -> Result<Option<String>, Error> {
    match fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => Ok(Some(text.trim().to_owned())),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::storage(format!("{}: {e}", path.display()))),
    }
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

    fn saved_secrets(&self) -> Result<Option<RoomSecrets>, Error> {
        let (Some(room), Some(bearer), Some(owner)) = (
            load(&self.dir.join("room.id"))?,
            load(&self.dir.join("bearer.secret"))?,
            load(&self.dir.join("relay-owner.secret"))?,
        ) else {
            return Ok(None);
        };
        Ok(Some(RoomSecrets { room, bearer, owner }))
    }

    fn hook_identity(&self) -> Result<HookIdentity, Error> {
        let path = self.dir.join("hooks.json");
        if let Some(identity) = read_hook_file(&path)? {
            return Ok(identity);
        }
        fs::create_dir_all(&self.dir).map_err(|e| Error::storage(format!("{}: {e}", self.dir.display())))?;
        let identity = HookIdentity { inbox: hex(&random::<16>()?), bearer: mint()?, secret_key: random::<32>()? };
        let file = HookFile {
            inbox: identity.inbox.clone(),
            bearer: identity.bearer.clone(),
            secret_key: base64::engine::general_purpose::STANDARD.encode(identity.secret_key),
        };
        let text = serde_json::to_vec(&file).map_err(Error::storage)?;
        let options = WriteOptions::with_permissions(eos_platform::host().private_file_permissions());
        atomic_write(&path, &text, &options).map_err(Error::storage)?;
        Ok(identity)
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
    fn saved_secrets_are_read_and_never_minted() {
        let home = tempfile::tempdir().expect("a folder");
        let dir = home.path().join("remote");
        let files = RemoteFiles::new(&dir);
        assert_eq!(files.saved_secrets().expect("read"), None);
        assert!(!dir.exists(), "asking writes nothing");
        let minted = files.secrets().expect("minted");
        assert_eq!(files.saved_secrets().expect("read"), Some(minted));
        fs::remove_file(dir.join("bearer.secret")).expect("removed");
        assert_eq!(files.saved_secrets().expect("read"), None, "one missing is none");
        assert!(!dir.join("bearer.secret").exists());
    }

    #[test]
    fn the_hook_identity_is_minted_once_private_and_never_replaced_when_unreadable() {
        let home = tempfile::tempdir().expect("a folder");
        let dir = home.path().join("remote");
        let files = RemoteFiles::new(&dir);
        let first = files.hook_identity().expect("minted");
        assert_eq!(first.inbox.len(), 32);
        assert!(first.inbox.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(first.bearer.len(), 43);
        assert_eq!(RemoteFiles::new(&dir).hook_identity().expect("loaded"), first, "a restart keeps the inbox");
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("hooks.json")).expect("written")).expect("json");
        let keys: Vec<&str> = written.as_object().expect("an object").keys().map(String::as_str).collect();
        assert_eq!(keys, ["inbox", "bearer", "secretKey"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("hooks.json")).expect("there").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        fs::write(dir.join("hooks.json"), "{broken").expect("written");
        assert!(files.hook_identity().is_err());
        assert_eq!(fs::read_to_string(dir.join("hooks.json")).expect("kept"), "{broken");
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
