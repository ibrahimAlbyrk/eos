//! `accounts/logins.json` (`infra/src/persistence/FilePlanLoginStore.ts`) and
//! the store folders beside it (`infra/src/auth/planLoginDirs.ts`).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use eos_core::Error;
use eos_core::accounts::{PlanLoginDirs, PlanLoginStore};
use eos_domain::accounts::{PlanLoginRecord, PlanLoginRegistry};
use eos_kit_fs::{WriteOptions, atomic_write, trash_stamp};
use serde_json::{Map, Value, json};

/// The plan sign-in registry as one JSON file, readable by its owner only.
/// It holds no credential, only where each one is stored.
#[derive(Debug)]
pub struct FilePlanLoginStore {
    file: PathBuf,
}

impl FilePlanLoginStore {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self { file: file.into() }
    }
}

fn text<'a>(entry: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn parse_login(value: &Value) -> Option<PlanLoginRecord> {
    let entry = value.as_object()?;
    Some(PlanLoginRecord {
        id: text(entry, "id")?.to_owned(),
        provider: text(entry, "provider")?.to_owned(),
        label: text(entry, "label")?.to_owned(),
        email: text(entry, "email").map(str::to_owned),
        store_dir: text(entry, "storeDir")?.to_owned(),
        created_at: text(entry, "createdAt")?.to_owned(),
    })
}

/// Entries that are not valid are dropped rather than failing the whole file.
fn parse(raw: &Value) -> PlanLoginRegistry {
    let mut registry = PlanLoginRegistry::default();
    let Some(root) = raw.as_object() else { return registry };
    if let Some(logins) = root.get("logins").and_then(Value::as_array) {
        registry.logins = logins.iter().filter_map(parse_login).collect();
    }
    if let Some(defaults) = root.get("defaults").and_then(Value::as_object) {
        for (provider, id) in defaults {
            if let Some(id) = id.as_str().filter(|id| registry.logins.iter().any(|l| l.id == *id)) {
                registry.defaults.insert(provider.clone(), id.to_owned());
            }
        }
    }
    if let Some(switches) = root.get("autoSwitch").and_then(Value::as_object) {
        for (provider, on) in switches {
            if let Some(on) = on.as_bool() {
                registry.auto_switch.insert(provider.clone(), on);
            }
        }
    }
    registry
}

fn document(registry: &PlanLoginRegistry) -> Value {
    let logins: Vec<Value> = registry
        .logins
        .iter()
        .map(|login| {
            let mut entry = Map::new();
            entry.insert("id".into(), login.id.clone().into());
            entry.insert("provider".into(), login.provider.clone().into());
            entry.insert("label".into(), login.label.clone().into());
            if let Some(email) = &login.email {
                entry.insert("email".into(), email.clone().into());
            }
            entry.insert("storeDir".into(), login.store_dir.clone().into());
            entry.insert("createdAt".into(), login.created_at.clone().into());
            Value::Object(entry)
        })
        .collect();
    let mut root = Map::new();
    root.insert("v".into(), json!(1));
    root.insert("logins".into(), logins.into());
    root.insert("defaults".into(), json!(registry.defaults));
    if !registry.auto_switch.is_empty() {
        root.insert("autoSwitch".into(), json!(registry.auto_switch));
    }
    Value::Object(root)
}

impl PlanLoginStore for FilePlanLoginStore {
    fn load(&self) -> PlanLoginRegistry {
        let raw = fs::read(&self.file).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        raw.map(|raw| parse(&raw)).unwrap_or_default()
    }

    fn save(&self, registry: &PlanLoginRegistry) -> Result<(), Error> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(Error::storage)?;
        }
        let text = serde_json::to_string_pretty(&document(registry)).map_err(Error::storage)?;
        let private = WriteOptions::with_permissions(eos_platform::host().private_file_permissions());
        atomic_write(&self.file, text.as_bytes(), &private).map_err(Error::storage)
    }
}

/// The credential store folders under `<home>/accounts`: one
/// `<name>-<loginId>` folder per sign-in of a provider that holds several
/// (Claude's first sign-in, from before it could, keeps the plain `claude`
/// folder), and one plain folder for a provider that holds one. Only folders
/// made here are ever removed; a signed-out store goes to `accounts/.trash`.
#[derive(Debug)]
pub struct AccountDirs {
    accounts: PathBuf,
}

/// The folder name of each provider's stores. ChatGPT's is not `codex`: that
/// folder is the Codex CLI's home of older installs, which this sign-in
/// cannot read.
fn folder(provider: &str) -> &str {
    match provider {
        "anthropic" => "claude",
        "openai" => "chatgpt",
        other => other,
    }
}

fn owner_only(dir: &Path) -> Result<(), Error> {
    eos_platform::create_private_dir(dir).map_err(Error::storage)
}

impl AccountDirs {
    pub fn new(accounts: impl Into<PathBuf>) -> Self {
        Self { accounts: accounts.into() }
    }

    fn inside(&self, store_dir: &str) -> bool {
        Path::new(store_dir).parent() == Some(self.accounts.as_path())
    }
}

impl PlanLoginDirs for AccountDirs {
    fn create(&self, provider: &str, id: &str) -> Result<String, Error> {
        let dir = self.accounts.join(format!("{}-{id}", folder(provider)));
        owner_only(&self.accounts)?;
        owner_only(&dir)?;
        Ok(dir.to_string_lossy().into_owned())
    }

    fn single(&self, provider: &str) -> String {
        self.accounts.join(folder(provider)).to_string_lossy().into_owned()
    }

    fn discard(&self, store_dir: &str) {
        let name = Path::new(store_dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let ours = ["claude-", "chatgpt-", "codex-", "gemini-"].iter().any(|prefix| name.starts_with(prefix));
        if self.inside(store_dir) && ours {
            let _ = fs::remove_dir_all(store_dir);
        }
    }

    fn trash(&self, store_dir: &str) -> Result<(), Error> {
        let dir = Path::new(store_dir);
        let Some(name) = dir.file_name().filter(|_| self.inside(store_dir) && dir.exists()) else { return Ok(()) };
        let trash = self.accounts.join(".trash");
        owner_only(&trash)?;
        let aside = trash.join(format!("{}.{}", name.to_string_lossy(), trash_stamp(SystemTime::now())));
        fs::rename(dir, aside).map_err(Error::storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::TempHome;

    fn login(id: &str, email: Option<&str>) -> PlanLoginRecord {
        PlanLoginRecord {
            id: id.into(),
            provider: "anthropic".into(),
            label: email.unwrap_or("Account 1").into(),
            email: email.map(str::to_owned),
            store_dir: format!("/home/.eos/accounts/claude-{id}"),
            created_at: "2026-01-01T09:30:00.125Z".into(),
        }
    }

    // infra/src/__tests__/FilePlanLoginStore.test.ts
    #[test]
    fn the_registry_survives_a_reopen_in_todays_format() {
        let home = TempHome::new();
        let store = FilePlanLoginStore::new(home.join("accounts/logins.json"));
        assert_eq!(store.load(), PlanLoginRegistry::default());

        let registry = PlanLoginRegistry::default()
            .with_login(login("lg-a", Some("a@example.com")))
            .with_login(login("lg-b", None))
            .with_default_login("anthropic", "lg-b")
            .with_auto_switch("anthropic", false);
        store.save(&registry).expect("saves");
        assert_eq!(store.load(), registry);
        // JSON.stringify({ v: 1, ...reg }, null, 2)
        assert!(home.read("accounts/logins.json").starts_with(
            "{\n  \"v\": 1,\n  \"logins\": [\n    {\n      \"id\": \"lg-a\",\n      \"provider\": \"anthropic\",\n      \"label\": \"a@example.com\",\n      \"email\": \"a@example.com\",\n      \"storeDir\":"
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(home.join("accounts/logins.json")).expect("the file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_file_the_typescript_app_wrote_is_read_and_bad_entries_are_dropped() {
        let home = TempHome::new();
        // The shape `FilePlanLoginStore.save` writes today, plus what a hand edit can break.
        home.write(
            "accounts/logins.json",
            r#"{ "v": 1,
                "logins": [
                  { "id": "lg-1a2b3c4d5e6f", "provider": "anthropic", "label": "Work", "storeDir": "/Users/x/.eos/accounts/claude", "createdAt": "2026-05-01T10:00:00.000Z", "email": "x@example.com" },
                  { "id": "lg-broken", "provider": "anthropic", "label": "" },
                  7
                ],
                "defaults": { "anthropic": "lg-gone", "openai": 5 },
                "autoSwitch": { "anthropic": false, "openai": "yes" } }"#,
        );
        let registry = FilePlanLoginStore::new(home.join("accounts/logins.json")).load();
        assert_eq!(registry.logins.len(), 1);
        assert_eq!(registry.logins[0].email.as_deref(), Some("x@example.com"));
        assert_eq!(registry.logins[0].store_dir, "/Users/x/.eos/accounts/claude");
        assert!(registry.defaults.is_empty(), "a default that names no login is dropped");
        assert_eq!(registry.default_login("anthropic").map(|l| l.id.as_str()), Some("lg-1a2b3c4d5e6f"));
        assert!(!registry.auto_switch("anthropic") && registry.auto_switch("openai"));

        home.write("accounts/logins.json", "{nope");
        assert_eq!(FilePlanLoginStore::new(home.join("accounts/logins.json")).load(), PlanLoginRegistry::default());
    }

    #[test]
    fn store_folders_are_made_discarded_and_trashed_only_under_accounts() {
        let home = TempHome::new();
        let accounts = home.join("accounts");
        let dirs = AccountDirs::new(&accounts);
        assert_eq!(dirs.single("anthropic"), accounts.join("claude").to_string_lossy());
        assert_eq!(dirs.single("openai"), accounts.join("chatgpt").to_string_lossy());

        let fresh = dirs.create("anthropic", "lg-1").expect("creates");
        assert_eq!(fresh, accounts.join("claude-lg-1").to_string_lossy());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&fresh).expect("the folder").permissions().mode() & 0o777, 0o700);
        }
        dirs.discard(&fresh);
        assert!(!Path::new(&fresh).exists());

        // The adopted store and anything outside are never discarded.
        let adopted = home.write("accounts/claude/.claude.json", "{}");
        let outside = home.write("elsewhere/claude-x/file", "");
        dirs.discard(&dirs.single("anthropic"));
        dirs.discard(&outside.parent().expect("dir").to_string_lossy());
        assert!(adopted.exists() && outside.exists());

        dirs.trash(&dirs.single("anthropic")).expect("moves aside");
        assert!(!adopted.exists());
        let trashed: Vec<String> = fs::read_dir(accounts.join(".trash"))
            .expect("the trash")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(trashed.len(), 1);
        assert!(trashed[0].starts_with("claude.20") && !trashed[0].ends_with('Z'), "{trashed:?}");
        dirs.trash(&dirs.single("anthropic")).expect("a store that is gone is not an error");
        dirs.trash(&outside.parent().expect("dir").to_string_lossy()).expect("ignored");
        assert!(outside.exists());
    }
}
