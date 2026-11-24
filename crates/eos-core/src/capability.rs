//! Capabilities: what Eos can reach for the user (GitHub, Mail, a package
//! the Forge built). Here, where their packages live on disk and where their
//! secrets are kept, the registry and the calls of their actions, and the
//! code that answers those calls; the rules over a package (its manifest,
//! its hash, its health) are `eos_domain::capability`.

use std::path::Path;

use zeroize::Zeroizing;

use crate::{BoxFuture, Error};

mod call;
mod confine;
mod reads;
mod registry;
mod sign_in;

pub use call::{
    ActionCall, ActionCaller, ActionDescription, ActionError, ActionResult, CapabilityCalls, CapabilityDescription,
    FailureKind,
};
pub use confine::{ConfineError, ConfineGuard, ConfineReport, ConfineSpec, Confined, Confinement, Violation};
pub use reads::{CapabilityHealth, CapabilityReads, Checkout, ItemRecogniser, MissingNeed, PastItemFilter};
pub use registry::{
    ActionContext, ActionRunner, AllInstalled, BuiltinCapability, Capability, CapabilityGrants, CapabilityRegistry,
    Grant, GrantedAction, INSTALLED_MAX, Package,
};
pub use sign_in::{BrowserCallback, BrowserCode, BrowserSignIn, DeviceCode, DeviceSignIn, SignInError};

/// The largest package installed, in bytes.
pub const PACKAGE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// The package folders under `<data folder>/capabilities`:
/// `<id>/<version>/`, which never changes once installed; `<id>/data/`, the
/// code's own state, which nothing here touches; and
/// `<id>/<version>.partial/` while a version installs. Nothing is deleted:
/// what goes, goes to the trash.
pub trait CapabilityFiles: Send + Sync {
    /// Copies the package in `package_dir` in as `<id>/<version>/`: into
    /// `<id>/<version>.partial/` first, renamed only when the copy's hash is
    /// `hash`, the one it was reviewed with. A copy with another hash goes to
    /// the trash and leaves no `<id>/<version>/`. A package of more than
    /// [`PACKAGE_MAX_BYTES`], or with anything but files and folders, is
    /// refused.
    fn install<'a>(
        &'a self,
        package_dir: &'a Path,
        id: &'a str,
        version: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// Moves `<id>/<version>/` to the trash.
    fn remove<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The installed package's hash (`eos_domain::capability::hash`).
    fn hash<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<String, Error>>;
    /// A cheap fingerprint of the installed package, from its files' paths,
    /// sizes and change times: when it differs from the one taken at
    /// install, the package is hashed again.
    fn stamp<'a>(&'a self, id: &'a str, version: &'a str) -> BoxFuture<'a, Result<String, Error>>;
    /// The text of `file`, a path inside the installed package (its
    /// instructions).
    fn read_text<'a>(&'a self, id: &'a str, version: &'a str, file: &'a str) -> BoxFuture<'a, Result<String, Error>>;
    /// Moves every `.partial` folder an install left behind (Eos stopped in
    /// the middle of one) to the trash; answers how many. Run at start.
    fn sweep(&self) -> BoxFuture<'_, Result<usize, Error>>;
}

/// The longest secret value kept, in bytes.
pub const SECRET_MAX_BYTES: usize = 8 * 1024;

/// A capability's secrets (tokens, keys), each named by the capability and
/// the secret's name in its manifest. Kept where only the app reads them
/// without the user being asked; never synced to other computers. Values
/// never reach a log or an error. A system without such a store keeps
/// nothing: reads find nothing and writes fail.
pub trait CapabilitySecrets: Send + Sync {
    /// The secret's value, or `None` when it is not set.
    fn read<'a>(
        &'a self,
        capability: &'a str,
        name: &'a str,
    ) -> BoxFuture<'a, Result<Option<Zeroizing<String>>, Error>>;
    /// Sets the secret, replacing a value already there. A value of more than
    /// [`SECRET_MAX_BYTES`] is refused.
    fn write<'a>(
        &'a self,
        capability: &'a str,
        name: &'a str,
        value: Zeroizing<String>,
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// Removes the secret; one that is not set is not an error.
    fn delete<'a>(&'a self, capability: &'a str, name: &'a str) -> BoxFuture<'a, Result<(), Error>>;
    /// The secret is set.
    fn has<'a>(&'a self, capability: &'a str, name: &'a str) -> BoxFuture<'a, Result<bool, Error>>;
}
