//! Capabilities: what Eos can reach for the user (GitHub, Mail, a package
//! the Forge built). Here, where their packages live on disk; the rules over
//! a package (its manifest, its hash) are `eos_domain::capability`.

use std::path::Path;

use crate::{BoxFuture, Error};

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
    /// Moves every `.partial` folder an install left behind (Eos stopped in
    /// the middle of one) to the trash; answers how many. Run at start.
    fn sweep(&self) -> BoxFuture<'_, Result<usize, Error>>;
}
