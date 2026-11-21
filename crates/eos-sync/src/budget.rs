//! The vault's share each domain may fill (09 §4.1): the relay keeps 256 MB
//! per vault, and a domain past its budget pushes no new record, so one
//! domain cannot crowd out the others. Deletions and changes of records the
//! vault holds still go.

use eos_contracts::SyncDomainName;
use eos_domain::sync::key::{NONCE_BYTES, TAG_BYTES};

/// What sealing adds to a record: its nonce and its tag.
pub(crate) const SEAL_OVERHEAD: u64 = (NONCE_BYTES + TAG_BYTES) as u64;

/// The budgets the app syncs with. Today's domains share the headroom and
/// have none of their own.
pub fn vault_budgets() -> Vec<(SyncDomainName, u64)> {
    Vec::new()
}

/// How full one domain is, as of the last pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainUsage {
    pub name: &'static str,
    /// The sealed bytes of its records this computer holds.
    pub bytes: u64,
    pub budget: Option<u64>,
    /// A new record was kept back because the budget was reached.
    pub full: bool,
}
