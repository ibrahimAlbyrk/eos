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
