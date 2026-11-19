//! Capability secrets in the app's own Keychain items.

use eos_core::capability::{CapabilitySecrets, SECRET_MAX_BYTES};
use eos_core::{BoxFuture, Error};
use eos_platform::AppSecretStore;
use zeroize::Zeroizing;

/// Every capability secret's item has this account; its service names it.
const ACCOUNT: &str = "eos";

/// The item a capability's secret is kept in.
fn service(capability: &str, name: &str) -> String {
    format!("eos-cap.{capability}.{name}")
}

/// [`CapabilitySecrets`] over the platform's [`AppSecretStore`]: item
/// `eos-cap.<capability>.<secret>`, account `eos`. Each call runs on the
/// blocking pool, since the Keychain blocks its caller.
#[derive(Debug, Clone, Copy)]
pub struct AppKeychainSecrets {
    store: Option<&'static dyn AppSecretStore>,
}

impl AppKeychainSecrets {
    /// The system's own store; none where the system has no such store.
    pub fn host() -> Self {
        Self::new(eos_platform::host().app_keychain())
    }

    pub fn new(store: Option<&'static dyn AppSecretStore>) -> Self {
        Self { store }
    }

    /// Runs `call` on the item's store, on the blocking pool; `none` is the
    /// answer where there is no store.
    fn on_item<'a, T: Send + 'static>(
        &self,
        capability: &str,
        name: &str,
        none: Result<T, Error>,
        call: impl FnOnce(&dyn AppSecretStore, &str) -> Result<T, eos_platform::Error> + Send + 'static,
    ) -> BoxFuture<'a, Result<T, Error>> {
        let Some(store) = self.store else { return Box::pin(std::future::ready(none)) };
        let service = service(capability, name);
        Box::pin(async move {
            let done = tokio::task::spawn_blocking(move || call(store, &service));
            done.await.map_err(Error::storage)?.map_err(Error::storage)
        })
    }
}

fn unavailable() -> Error {
    Error::storage(eos_platform::Error::Unsupported("secret storage"))
}

impl CapabilitySecrets for AppKeychainSecrets {
    fn read<'a>(
        &'a self,
        capability: &'a str,
        name: &'a str,
    ) -> BoxFuture<'a, Result<Option<Zeroizing<String>>, Error>> {
        self.on_item(capability, name, Ok(None), |store, service| store.read(service, ACCOUNT))
    }

    fn write<'a>(
        &'a self,
        capability: &'a str,
        name: &'a str,
        value: Zeroizing<String>,
    ) -> BoxFuture<'a, Result<(), Error>> {
        if value.len() > SECRET_MAX_BYTES {
            let refused = Error::Validation(format!("a secret is at most {SECRET_MAX_BYTES} bytes"));
            return Box::pin(std::future::ready(Err(refused)));
        }
        self.on_item(capability, name, Err(unavailable()), move |store, service| store.write(service, ACCOUNT, &value))
    }

    fn delete<'a>(&'a self, capability: &'a str, name: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.on_item(capability, name, Ok(()), |store, service| store.delete(service, ACCOUNT))
    }

    fn has<'a>(&'a self, capability: &'a str, name: &'a str) -> BoxFuture<'a, Result<bool, Error>> {
        self.on_item(capability, name, Ok(false), |store, service| store.has(service, ACCOUNT))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// Items by service and account, as the Keychain names them.
    #[derive(Debug, Default)]
    struct Items(Mutex<HashMap<(String, String), String>>);

    impl Items {
        fn leaked() -> &'static Items {
            Box::leak(Box::default())
        }

        fn keys(&self) -> Vec<(String, String)> {
            self.0.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect()
        }
    }

    impl AppSecretStore for Items {
        fn read(&self, service: &str, account: &str) -> Result<Option<Zeroizing<String>>, eos_platform::Error> {
            let items = self.0.lock().unwrap_or_else(|p| p.into_inner());
            Ok(items.get(&(service.to_owned(), account.to_owned())).cloned().map(Zeroizing::new))
        }

        fn write(&self, service: &str, account: &str, value: &str) -> Result<(), eos_platform::Error> {
            let mut items = self.0.lock().unwrap_or_else(|p| p.into_inner());
            items.insert((service.to_owned(), account.to_owned()), value.to_owned());
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), eos_platform::Error> {
            self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&(service.to_owned(), account.to_owned()));
            Ok(())
        }

        fn has(&self, service: &str, account: &str) -> Result<bool, eos_platform::Error> {
            Ok(self.0.lock().unwrap_or_else(|p| p.into_inner()).contains_key(&(service.to_owned(), account.to_owned())))
        }
    }

    #[tokio::test]
    async fn each_secret_is_its_own_item_under_the_eos_account() {
        let items = Items::leaked();
        let secrets = AppKeychainSecrets::new(Some(items));
        secrets.write("github", "token", Zeroizing::new("gho-1".to_owned())).await.expect("write");

        assert_eq!(items.keys(), [("eos-cap.github.token".to_owned(), "eos".to_owned())]);
        assert!(secrets.has("github", "token").await.expect("has"));
        assert_eq!(secrets.read("github", "token").await.expect("read").as_deref().map(String::as_str), Some("gho-1"));
        assert!(!secrets.has("mail", "token").await.expect("has"), "another capability's name finds nothing");

        secrets.delete("github", "token").await.expect("delete");
        assert_eq!(secrets.read("github", "token").await.expect("read"), None);
    }

    #[tokio::test]
    async fn a_value_over_the_limit_is_refused_and_not_kept() {
        let items = Items::leaked();
        let secrets = AppKeychainSecrets::new(Some(items));
        let long = Zeroizing::new("k".repeat(SECRET_MAX_BYTES + 1));
        let refused = secrets.write("github", "token", long).await.expect_err("too long");
        assert!(matches!(refused, Error::Validation(_)));
        assert!(!refused.to_string().contains("kkkk"), "the error quotes no value");
        assert!(items.keys().is_empty());
        let longest = Zeroizing::new("k".repeat(SECRET_MAX_BYTES));
        secrets.write("github", "token", longest).await.expect("the limit itself is kept");
    }

    #[tokio::test]
    async fn without_a_store_nothing_is_kept_or_found() {
        let secrets = AppKeychainSecrets::new(None);
        assert!(secrets.write("github", "token", Zeroizing::new("gho-1".to_owned())).await.is_err());
        assert_eq!(secrets.read("github", "token").await.expect("read"), None);
        assert!(!secrets.has("github", "token").await.expect("has"));
        secrets.delete("github", "token").await.expect("deleting nothing is not an error");
    }
}
