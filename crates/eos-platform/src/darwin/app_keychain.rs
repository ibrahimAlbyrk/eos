//! Keychain items the app makes itself, through the Security framework
//! (`security-framework`'s safe API), never `security(1)`.
//!
//! An item a program adds without an access list trusts only that program:
//! any other one, an agent's shell running `security` included, gets a system
//! prompt before it reads the item. The Developer-ID app keeps that trust
//! across updates.

use std::path::PathBuf;

use security_framework::os::macos::keychain::SecKeychain;
use security_framework::os::macos::keychain_item::SecKeychainItem;
use security_framework::os::macos::passwords::{SecKeychainItemPassword, find_generic_password};
use zeroize::Zeroizing;

use crate::error::Error;
use crate::host::AppSecretStore;

/// The Security framework's "no such item" (`errSecItemNotFound`).
const ITEM_NOT_FOUND: i32 = -25300;
/// The Security framework's "cannot decode" (`errSecDecode`): an item that is not UTF-8 text.
const NOT_TEXT: i32 = -26275;

/// Generic-password items in a keychain. The default is the user's own
/// keychains (the search list to read, the default keychain to write); tests
/// point it at a keychain file of their own.
#[derive(Debug, Clone)]
pub struct AppKeychain {
    keychain: Option<PathBuf>,
}

impl AppKeychain {
    pub const fn login() -> Self {
        Self { keychain: None }
    }

    pub fn file(keychain: impl Into<PathBuf>) -> Self {
        Self { keychain: Some(keychain.into()) }
    }

    fn open(&self) -> Result<SecKeychain, Error> {
        match &self.keychain {
            Some(path) => SecKeychain::open(path),
            None => SecKeychain::default(),
        }
        .map_err(refused)
    }

    fn find(&self, service: &str, account: &str) -> Result<Option<(SecKeychainItemPassword, SecKeychainItem)>, Error> {
        let found = match &self.keychain {
            Some(_) => self.open()?.find_generic_password(service, account),
            None => find_generic_password(None, service, account),
        };
        match found {
            Ok(item) => Ok(Some(item)),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(refused(e)),
        }
    }
}

/// Only the status code: the framework's message never names a value, but a code is all a caller acts on.
fn refused(e: security_framework::base::Error) -> Error {
    Error::Keychain(e.code())
}

impl AppSecretStore for AppKeychain {
    fn read(&self, service: &str, account: &str) -> Result<Option<Zeroizing<String>>, Error> {
        let Some((password, _)) = self.find(service, account)? else { return Ok(None) };
        let bytes = Zeroizing::new(password.to_vec());
        let text = std::str::from_utf8(&bytes).map_err(|_| Error::Keychain(NOT_TEXT))?;
        Ok(Some(Zeroizing::new(text.to_owned())))
    }

    fn write(&self, service: &str, account: &str, value: &str) -> Result<(), Error> {
        self.open()?.set_generic_password(service, account, value.as_bytes()).map_err(refused)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), Error> {
        if let Some((_, item)) = self.find(service, account)? {
            item.delete();
        }
        Ok(())
    }

    fn has(&self, service: &str, account: &str) -> Result<bool, Error> {
        Ok(self.find(service, account)?.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::darwin::keychain::tests::Throwaway;

    #[test]
    fn an_item_is_written_found_read_rotated_and_deleted() {
        let throwaway = Throwaway::create();
        let keychain = AppKeychain::file(&throwaway.path);
        let service = "eos-cap.sms-messages.token";

        assert!(!keychain.has(service, "eos").expect("has"));
        assert_eq!(keychain.read(service, "eos").expect("read"), None);
        keychain.write(service, "eos", "sk-first").expect("write");
        assert!(keychain.has(service, "eos").expect("has"));
        assert_eq!(keychain.read(service, "eos").expect("read").as_deref().map(String::as_str), Some("sk-first"));
        keychain.write(service, "eos", "sk-second").expect("rotate");
        assert_eq!(keychain.read(service, "eos").expect("read").as_deref().map(String::as_str), Some("sk-second"));

        keychain.delete(service, "eos").expect("delete");
        assert_eq!(keychain.read(service, "eos").expect("read"), None);
        keychain.delete(service, "eos").expect("deleting nothing is not an error");
    }

    #[test]
    fn one_capabilitys_item_is_not_found_under_anothers_name() {
        let throwaway = Throwaway::create();
        let keychain = AppKeychain::file(&throwaway.path);
        keychain.write("eos-cap.first.token", "eos", "sk-first").expect("write");

        assert!(!keychain.has("eos-cap.second.token", "eos").expect("has"));
        assert_eq!(keychain.read("eos-cap.second.token", "eos").expect("read"), None);
        assert_eq!(
            keychain.read("eos-cap.first.token", "other").expect("read"),
            None,
            "the account names the item too"
        );
    }
}
