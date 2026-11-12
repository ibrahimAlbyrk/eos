//! Sync domains over the data that has a service as its one write path
//! (`manager/services/user-sync-domains.ts`, `manager/modules/pages/syncDomain.ts`):
//! profile fields, the avatar, memories and pages. Each lists the portable
//! form (project folders as project keys, no local revisions or chat links)
//! and applies it back through that service, so open views refresh off the
//! usual change events.

mod avatar;
mod memory;
mod page;
mod profile;
mod project_ref;

use std::sync::Arc;

use eos_contracts::SyncDomainName;
use eos_core::Error;
use eos_core::git::ProjectKeys;
use eos_core::net::sync::SyncDomain;
use eos_core::pages::PageSync;
use eos_core::profile::{UserMemorySync, UserProfileSync};
use eos_runtime::module::SyncContribution;

pub use avatar::AvatarDomain;
pub use memory::MemoryDomain;
pub use page::PageDomain;
pub use profile::ProfileDomain;

/// The order domains are pushed in (and listed in the status).
pub(crate) fn push_order(name: SyncDomainName) -> u8 {
    match name {
        SyncDomainName::Profile => 0,
        SyncDomainName::Avatar => 1,
        SyncDomainName::Memory => 2,
        SyncDomainName::Template => 3,
        SyncDomainName::Worker => 4,
        SyncDomainName::Page => 5,
    }
}

/// Data that cannot be a record of its domain.
pub(crate) fn refused(what: impl std::fmt::Display) -> Error {
    Error::Validation(what.to_string())
}

/// The domain a feature's contribution stands for: its handle is the
/// feature's sync face (`Arc<dyn PageSync>`, …), named by `domain`.
pub(crate) fn from_contribution(
    contribution: &SyncContribution,
    project_keys: &Arc<dyn ProjectKeys>,
) -> Result<Arc<dyn SyncDomain>, Error> {
    let wrong = || {
        Error::Rule(format!(
            "the \"{}\" sync domain was contributed with a handle sync cannot use",
            contribution.domain
        ))
    };
    let handle = &contribution.handle;
    Ok(match contribution.domain {
        "profile" => {
            Arc::new(ProfileDomain::new(handle.downcast_ref::<Arc<dyn UserProfileSync>>().ok_or_else(wrong)?.clone()))
        }
        "avatar" => {
            Arc::new(AvatarDomain::new(handle.downcast_ref::<Arc<dyn UserProfileSync>>().ok_or_else(wrong)?.clone()))
        }
        "memory" => Arc::new(MemoryDomain::new(
            handle.downcast_ref::<Arc<dyn UserMemorySync>>().ok_or_else(wrong)?.clone(),
            project_keys.clone(),
        )),
        "page" => Arc::new(PageDomain::new(
            handle.downcast_ref::<Arc<dyn PageSync>>().ok_or_else(wrong)?.clone(),
            project_keys.clone(),
        )),
        other => return Err(Error::Rule(format!("no sync domain is called \"{other}\""))),
    })
}
