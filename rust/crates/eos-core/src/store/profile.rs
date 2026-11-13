//! The user's profile and its avatar image on disk
//! (`core/src/ports/UserProfileStore.ts`): `<home>/profile/profile.json` and
//! `<home>/profile/avatar.<png|jpeg|webp>`.

use std::sync::Arc;

use eos_contracts::{AvatarExt, UserProfile};

use crate::Error;

pub trait UserProfileStore: Send + Sync + 'static {
    /// `None`: never saved, or the file no longer reads as a profile.
    fn get(&self) -> Option<Arc<UserProfile>>;
    fn put(&self, profile: UserProfile) -> Result<Arc<UserProfile>, Error>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAvatar {
    pub bytes: Vec<u8>,
    pub ext: AvatarExt,
}

pub trait UserAvatarStore: Send + Sync + 'static {
    fn read(&self) -> Result<Option<UserAvatar>, Error>;
    /// Replaces any previous avatar, whatever its type.
    fn write(&self, avatar: &UserAvatar) -> Result<(), Error>;
    fn remove(&self) -> Result<(), Error>;
}

/// The avatar made small for drawing at a known size. Blocking: it reads and writes
/// files and may run the system's image tool.
pub trait AvatarThumbnails: Send + Sync + 'static {
    /// A PNG of the avatar whose shorter side is `size` pixels, kept until the avatar
    /// changes. The stored avatar itself when it is not larger, or when it cannot be
    /// scaled here (no image tool on this system, a header this cannot read, an image
    /// its metadata turns). `None` when there is no avatar.
    fn thumbnail(&self, size: u32) -> Result<Option<UserAvatar>, Error>;
}
