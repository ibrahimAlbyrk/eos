//! Capabilities: what Eos can reach for the user (GitHub, Mail, a phone
//! push, a package the Forge built). The manifest a capability declares
//! itself in and the check it passes before it runs, the schemas its
//! actions take and give, the hosts it may reach, the secrets cut from what
//! it says, the hash its package is pinned by, and its health. Pure: the
//! service reads files, secrets and the clock and hands the values in. An
//! action's class is `eos_contracts::ActionClass`, the one Freedom uses.

pub mod check;
pub mod hash;
pub mod health;
pub mod manifest;
pub mod reach;
pub mod schema;
pub mod scrub;

#[cfg(test)]
mod tests;
