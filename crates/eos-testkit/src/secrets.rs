//! Capability secrets kept in memory.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use eos_core::capability::{CapabilitySecrets, SECRET_MAX_BYTES};
use eos_core::{BoxFuture, Error};
use zeroize::Zeroizing;

/// Secrets by capability and name, held in memory, with the real store's
/// size limit.
#[derive(Debug, Default)]
pub struct FakeCapabilitySecrets {
    values: Mutex<HashMap<(String, String), Zeroizing<String>>>,
}

impl FakeCapabilitySecrets {
    pub fn new() -> Self {
        Self::default()
    }

    /// The secret `name` of `capability` is set to `value`.
    pub fn with(self, capability: &str, name: &str, value: &str) -> Self {
        self.locked().insert(key(capability, name), Zeroizing::new(value.to_owned()));
        self
    }

    fn locked(&self) -> MutexGuard<'_, HashMap<(String, String), Zeroizing<String>>> {
        self.values.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn key(capability: &str, name: &str) -> (String, String) {
    (capability.to_owned(), name.to_owned())
}

impl CapabilitySecrets for FakeCapabilitySecrets {
    fn read<'a>(
        &'a self,
        capability: &'a str,
        name: &'a str,
    ) -> BoxFuture<'a, Result<Option<Zeroizing<String>>, Error>> {
        Box::pin(std::future::ready(Ok(self.locked().get(&key(capability, name)).cloned())))
    }

    fn write<'a>(
        &'a self,
        capability: &'a str,
        name: &'a str,
        value: Zeroizing<String>,
    ) -> BoxFuture<'a, Result<(), Error>> {
        let written = if value.len() > SECRET_MAX_BYTES {
            Err(Error::Validation(format!("a secret is at most {SECRET_MAX_BYTES} bytes")))
        } else {
            self.locked().insert(key(capability, name), value);
            Ok(())
        };
        Box::pin(std::future::ready(written))
    }

    fn delete<'a>(&'a self, capability: &'a str, name: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        self.locked().remove(&key(capability, name));
        Box::pin(std::future::ready(Ok(())))
    }

    fn has<'a>(&'a self, capability: &'a str, name: &'a str) -> BoxFuture<'a, Result<bool, Error>> {
        Box::pin(std::future::ready(Ok(self.locked().contains_key(&key(capability, name)))))
    }
}
