//! The macOS Keychain, through `security(1)`: where the claude binary keeps
//! its logins and where Eos keeps provider API keys.
//!
//! Why the tool and not the Keychain API: an item is readable without a prompt
//! only by the program that created it. Items `security` created (every Claude
//! login, every key today's app saved) are closed to any other binary, and an
//! ad-hoc signed build loses its own items on every rebuild. Behind
//! [`CredentialStore`] an in-process implementation can take over for items a
//! Developer-ID build creates itself.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::error::Error;
use crate::host::{CredentialStore, claude_store_service};
use crate::tool;

const SECURITY: &str = "/usr/bin/security";
const TIMEOUT: Duration = Duration::from_secs(15);
/// The longest line `security -i` reads.
const SECURITY_LINE_MAX: usize = 4032;

/// Generic-password items in a keychain. The default is the user's login
/// keychain (the search list); tests point it at a keychain file of their own.
#[derive(Debug, Clone)]
pub struct SecurityKeychain {
    keychain: Option<PathBuf>,
}

impl SecurityKeychain {
    pub const fn login() -> Self {
        Self { keychain: None }
    }

    pub fn file(keychain: impl Into<PathBuf>) -> Self {
        Self { keychain: Some(keychain.into()) }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(SECURITY);
        command.args(args);
        if let Some(keychain) = &self.keychain {
            command.arg(keychain);
        }
        command
    }
}

/// Escapes a value for a double-quoted argument of a `security -i` line.
fn quoted(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The account the claude binary gives a login item it creates: `$USER`
/// when it is a plain name, else a fixed one.
fn claude_account() -> String {
    std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty() && u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
        .unwrap_or_else(|| "claude-code-user".to_owned())
}

impl SecurityKeychain {
    /// The account attribute of the item under `service`. An item is named by
    /// its service and its account together, so an update must give both.
    fn account_of(&self, service: &str) -> Option<String> {
        let out = tool::run("security", &mut self.command(&["find-generic-password", "-s", service]), None, TIMEOUT);
        let out = out.ok().filter(|out| out.status.success())?;
        let line = out.stdout.lines().find(|l| l.trim_start().starts_with("\"acct\""))?;
        Some(line.split_once("=\"")?.1.strip_suffix('"')?.to_owned())
    }

    // `-U` updates an existing item, so saving again rotates it in place.
    // The secret travels as hex on stdin (`security -i`), so it never shows in
    // the process list; only a line too long for the tool's reader goes as arguments.
    fn write_item(&self, service: &str, account: &str, secret: &str) -> Result<(), Error> {
        let value = hex(secret.as_bytes());
        let keychain = self.keychain.as_ref().map(|k| k.to_string_lossy().into_owned());
        let mut line =
            format!("add-generic-password -U -s \"{}\" -a \"{}\" -X \"{value}\"", quoted(service), quoted(account));
        if let Some(keychain) = &keychain {
            line.push_str(&format!(" \"{}\"", quoted(keychain)));
        }
        line.push('\n');
        if line.len() <= SECURITY_LINE_MAX && !service.contains('\n') && !account.contains('\n') {
            tool::run_ok("security", Command::new(SECURITY).arg("-i"), Some(line.as_bytes()), TIMEOUT).map(drop)
        } else {
            let args = ["add-generic-password", "-U", "-s", service, "-a", account, "-X", &value];
            tool::run_ok("security", &mut self.command(&args), None, TIMEOUT).map(drop)
        }
    }
}

impl CredentialStore for SecurityKeychain {
    fn read_claude_store(&self, store_dir: Option<&Path>) -> Option<String> {
        self.read_secret(&claude_store_service(store_dir))
    }

    fn write_claude_store(&self, store_dir: &Path, json: &str) -> Result<(), Error> {
        let service = claude_store_service(Some(store_dir));
        let account = self.account_of(&service).unwrap_or_else(claude_account);
        self.write_item(&service, &account, json)
    }

    fn clear_claude_store(&self, store_dir: &Path) {
        self.delete_secret(&claude_store_service(Some(store_dir)));
    }

    fn read_secret(&self, service: &str) -> Option<String> {
        let out =
            tool::run_ok("security", &mut self.command(&["find-generic-password", "-s", service, "-w"]), None, TIMEOUT)
                .ok()?;
        Some(out.stdout.trim().to_owned()).filter(|v| !v.is_empty())
    }

    fn write_secret(&self, service: &str, secret: &str) -> Result<(), Error> {
        self.write_item(service, service, secret)
    }

    fn delete_secret(&self, service: &str) {
        // No such item: nothing to delete.
        let _ = tool::run("security", &mut self.command(&["delete-generic-password", "-s", service]), None, TIMEOUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A keychain file of the test's own. The login keychain is never opened
    /// and the user's search list is left as it was.
    struct Throwaway {
        _dir: tempfile::TempDir,
        path: PathBuf,
        search_list: String,
    }

    fn security(args: &[&str]) -> String {
        let out = Command::new(SECURITY).args(args).output().expect("security");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    impl Throwaway {
        fn create() -> Self {
            let dir = tempfile::tempdir().expect("dir");
            let path = dir.path().join("eos-test.keychain-db");
            let p = path.to_str().expect("utf-8 path").to_owned();
            let search_list = security(&["list-keychains", "-d", "user"]);
            security(&["create-keychain", "-p", "test", &p]);
            security(&["set-keychain-settings", &p]);
            security(&["unlock-keychain", "-p", "test", &p]);
            Self { _dir: dir, path, search_list }
        }
    }

    impl Drop for Throwaway {
        fn drop(&mut self) {
            security(&["delete-keychain", self.path.to_str().unwrap_or_default()]);
            let after = security(&["list-keychains", "-d", "user"]);
            if after != self.search_list {
                // Creating a keychain must not change the search list; put it back if it did.
                let before: Vec<String> =
                    self.search_list.lines().map(|l| l.trim().trim_matches('"').to_owned()).collect();
                let mut args = vec!["list-keychains", "-d", "user", "-s"];
                args.extend(before.iter().map(String::as_str));
                security(&args);
            }
        }
    }

    #[test]
    fn a_secret_is_saved_read_rotated_and_removed() {
        let throwaway = Throwaway::create();
        let search_list = throwaway.search_list.clone();
        let keychain = SecurityKeychain::file(&throwaway.path);
        let service = "eos-test \"quoted\\service\"";

        assert_eq!(keychain.read_secret(service), None);
        keychain.write_secret(service, "sk-first").expect("write");
        assert_eq!(keychain.read_secret(service).as_deref(), Some("sk-first"));
        keychain.write_secret(service, "sk-second with spaces & \"quotes\"").expect("rotate");
        assert_eq!(keychain.read_secret(service).as_deref(), Some("sk-second with spaces & \"quotes\""));

        // Too long for the stdin line: goes as arguments, same result.
        let long = "k".repeat(3000);
        keychain.write_secret(service, &long).expect("long");
        assert_eq!(keychain.read_secret(service).as_deref(), Some(long.as_str()));

        keychain.delete_secret(service);
        assert_eq!(keychain.read_secret(service), None);
        keychain.delete_secret(service);
        assert_eq!(security(&["list-keychains", "-d", "user"]), search_list, "the search list is untouched");
    }

    #[test]
    fn a_claude_login_is_read_and_cleared_under_its_store_item() {
        let throwaway = Throwaway::create();
        let keychain = SecurityKeychain::file(&throwaway.path);
        let store = Path::new("/tmp/eos-test/accounts/claude");
        assert_eq!(keychain.read_claude_store(Some(store)), None);
        keychain.write_secret(&claude_store_service(Some(store)), "{\"claudeAiOauth\":{}}").expect("write");
        assert_eq!(keychain.read_claude_store(Some(store)).as_deref(), Some("{\"claudeAiOauth\":{}}"));
        keychain.clear_claude_store(store);
        assert_eq!(keychain.read_claude_store(Some(store)), None);
    }

    #[test]
    fn a_login_the_claude_binary_wrote_is_rewritten_in_place() {
        let throwaway = Throwaway::create();
        let keychain = SecurityKeychain::file(&throwaway.path);
        let store = Path::new("/tmp/eos-test/accounts/claude-lg-1");
        let service = claude_store_service(Some(store));
        let p = throwaway.path.to_str().expect("utf-8 path");
        // As the claude binary creates it: the account is the user's name.
        security(&["add-generic-password", "-s", &service, "-a", "someone", "-w", "{\"claudeAiOauth\":{\"v\":1}}", p]);
        assert_eq!(keychain.account_of(&service).as_deref(), Some("someone"));

        keychain.write_claude_store(store, "{\"claudeAiOauth\":{\"v\":2}}").expect("rewrites");
        assert_eq!(keychain.read_claude_store(Some(store)).as_deref(), Some("{\"claudeAiOauth\":{\"v\":2}}"));
        let dump = security(&["dump-keychain", p]);
        assert_eq!(dump.matches(&format!("\"svce\"<blob>=\"{service}\"")).count(), 1, "one item, not a second one");

        // A store with no item yet gets one under the claude binary's account.
        let fresh = Path::new("/tmp/eos-test/accounts/claude-lg-2");
        keychain.write_claude_store(fresh, "{}").expect("creates");
        assert_eq!(keychain.account_of(&claude_store_service(Some(fresh))), Some(claude_account()));
    }

    #[test]
    fn store_folders_get_the_item_the_claude_binary_uses() {
        assert_eq!(claude_store_service(None), "Claude Code-credentials");
        // sha256("/tmp/store") = 46c7b2e9…: the same rule as infra/src/platform/keychain.ts.
        let service = claude_store_service(Some(Path::new("/tmp/store")));
        assert!(service.starts_with("Claude Code-credentials-"));
        assert_eq!(service.len(), "Claude Code-credentials-".len() + 8);
        // NFC: a decomposed "é" names the same item as the composed one.
        assert_eq!(
            claude_store_service(Some(Path::new("/tmp/cafe\u{301}"))),
            claude_store_service(Some(Path::new("/tmp/caf\u{e9}")))
        );
    }
}
