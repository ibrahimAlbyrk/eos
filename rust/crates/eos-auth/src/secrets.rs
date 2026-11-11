//! The system's secret store behind the ports.

use std::path::Path;

use eos_core::Error;
use eos_core::accounts::Secrets;
use eos_platform::CredentialStore;

/// The secret store of the system Eos runs on.
#[derive(Debug, Default, Clone, Copy)]
pub struct HostCredentials;

impl CredentialStore for HostCredentials {
    fn read_claude_store(&self, store_dir: Option<&Path>) -> Option<String> {
        eos_platform::host().credentials().read_claude_store(store_dir)
    }

    fn write_claude_store(&self, store_dir: &Path, json: &str) -> Result<(), eos_platform::Error> {
        eos_platform::host().credentials().write_claude_store(store_dir, json)
    }

    fn clear_claude_store(&self, store_dir: &Path) {
        eos_platform::host().credentials().clear_claude_store(store_dir);
    }

    fn read_secret(&self, service: &str) -> Option<String> {
        eos_platform::host().credentials().read_secret(service)
    }

    fn write_secret(&self, service: &str, secret: &str) -> Result<(), eos_platform::Error> {
        eos_platform::host().credentials().write_secret(service, secret)
    }

    fn delete_secret(&self, service: &str) {
        eos_platform::host().credentials().delete_secret(service);
    }
}

/// Provider API keys: one secret per service name (`eos-openai`, …), the
/// names today's keys are saved under.
#[derive(Debug)]
pub struct PlatformSecrets<C = HostCredentials>(pub C);

impl<C: CredentialStore + 'static> Secrets for PlatformSecrets<C> {
    fn read(&self, service: &str) -> Option<String> {
        self.0.read_secret(service)
    }

    fn write(&self, service: &str, secret: &str) -> Result<(), Error> {
        self.0.write_secret(service, secret).map_err(Error::storage)
    }

    fn delete(&self, service: &str) {
        self.0.delete_secret(service);
    }
}
