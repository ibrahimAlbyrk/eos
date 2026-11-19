//! Signing in to a capability by a code the user enters on the service's
//! own page (OAuth's device flow): Eos never sees a password, and the token
//! it gets is kept with the capability's secrets.

use std::fmt;

use zeroize::Zeroizing;

use crate::BoxFuture;

/// A sign-in under way: what the user is shown, and what the service asked
/// to be polled with. The codes never reach a log, an error or a frame.
pub struct DeviceCode {
    /// What the user types on the service's page.
    pub user_code: Zeroizing<String>,
    /// The page the user opens.
    pub verification_uri: String,
    /// When the code stops working, in ms.
    pub expires_at: i64,
    /// What Eos polls the service with.
    pub device_code: Zeroizing<String>,
    /// How long to wait between polls at first, in seconds.
    pub interval_s: u64,
}

impl fmt::Debug for DeviceCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceCode")
            .field("verification_uri", &self.verification_uri)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// Why a sign-in did not start or did not finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SignInError {
    /// The capability has no client id to sign in with
    /// (`client_id_missing`).
    ClientIdMissing,
    /// The code was not entered in time.
    Expired,
    /// The user refused on the service's page.
    Denied,
    /// The service limited the rate; try again later.
    RateLimited,
    /// The service failed, or the token could not be kept.
    Failed,
}

/// A capability the user signs in to by a code (GitHub).
pub trait DeviceSignIn: Send + Sync {
    /// Asks the service for a code.
    fn start(&self) -> BoxFuture<'_, Result<DeviceCode, SignInError>>;
    /// Polls until the user entered `code`, then keeps the token with the
    /// capability's secrets and answers the account's name (its label,
    /// never logged). Dropped, it stops polling.
    fn finish<'a>(&'a self, code: &'a DeviceCode) -> BoxFuture<'a, Result<String, SignInError>>;
}
