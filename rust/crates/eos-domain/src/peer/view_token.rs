//! View tokens (`ViewTokens` in `manager/peer/facade.ts`).
//!
//! The window shows each controlled computer's dashboard in its own isolated
//! view, possibly running that computer's own code. Such a view never gets
//! this computer's ui-token (it would let that code drive this computer); it
//! gets a token that counts as "the user" only for its own host.
//!
//! The token is derived, not stored — `HMAC-SHA256(ui-token, "eos-view:" +
//! host id)` in hex — so an open view's token still holds after a restart.

use std::collections::HashSet;
use std::sync::Mutex;

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use super::same_bytes;

pub fn view_token(ui_token: &str, host_id: &str) -> String {
    // HMAC takes a key of any length.
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(ui_token.as_bytes()) else { return String::new() };
    mac.update(b"eos-view:");
    mac.update(host_id.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub struct ViewTokens {
    secret: String,
    /// Hosts the user forgot: their tokens stop counting until minted again.
    revoked: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for ViewTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ViewTokens").finish_non_exhaustive()
    }
}

impl ViewTokens {
    /// `secret` is this computer's ui-token.
    pub fn new(secret: impl Into<String>) -> Self {
        Self { secret: secret.into(), revoked: Mutex::new(HashSet::new()) }
    }

    fn revoked(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.revoked.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn mint(&self, host_id: &str) -> String {
        self.revoked().remove(host_id);
        view_token(&self.secret, host_id)
    }

    pub fn valid_for(&self, token: &str, host_id: &str) -> bool {
        if self.revoked().contains(host_id) {
            return false;
        }
        same_bytes(token.as_bytes(), view_token(&self.secret, host_id).as_bytes())
    }

    pub fn revoke_host(&self, host_id: &str) {
        self.revoked().insert(host_id.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `new ViewTokens("t".repeat(48)).mint("ab".repeat(32))` (manager/peer/facade.ts).
    #[test]
    fn a_token_equals_the_typescript_one() {
        assert_eq!(
            view_token(&"t".repeat(48), &"ab".repeat(32)),
            "8f7e3f9b51d098515c076e7f8152541aeedd85808c9bc20bad137b79fee16d4f"
        );
    }

    #[test]
    fn a_token_counts_for_its_own_host_only_and_survives_a_restart() {
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        let tokens = ViewTokens::new("s".repeat(48));
        let token = tokens.mint(&a);
        assert!(tokens.valid_for(&token, &a));
        assert!(!tokens.valid_for(&token, &b));
        assert!(!tokens.valid_for("", &a));
        assert!(ViewTokens::new("s".repeat(48)).valid_for(&token, &a), "derived, so a new run accepts it");
        assert!(!ViewTokens::new("x".repeat(48)).valid_for(&token, &a));
    }

    #[test]
    fn forgetting_a_host_stops_its_token_until_it_is_minted_again() {
        let a = "a".repeat(64);
        let tokens = ViewTokens::new("s".repeat(48));
        let token = tokens.mint(&a);
        tokens.revoke_host(&a);
        assert!(!tokens.valid_for(&token, &a));
        assert_eq!(tokens.mint(&a), token);
        assert!(tokens.valid_for(&token, &a));
    }
}
