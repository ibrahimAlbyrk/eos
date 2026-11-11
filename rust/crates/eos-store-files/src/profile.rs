//! The user's profile as `<home>/profile/profile.json` and its avatar as
//! `<home>/profile/avatar.<png|jpeg|webp>`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use eos_contracts::{AvatarExt, UserProfile};
use eos_core::Error;
use eos_core::store::{UserAvatar, UserAvatarStore, UserProfileStore};
use eos_kit_fs::{PathLocks, WriteOptions, atomic_write};

/// The profile, read once and written through. A file that no longer reads as
/// a profile counts as "never saved" rather than failing every prompt.
#[derive(Debug)]
pub struct FileUserProfileStore {
    path: PathBuf,
    locks: PathLocks,
    cached: RwLock<Option<Arc<UserProfile>>>,
}

impl FileUserProfileStore {
    pub fn open(dir: impl AsRef<Path>) -> Self {
        let path = dir.as_ref().join("profile.json");
        let cached = fs::read_to_string(&path).ok().and_then(|raw| parse_user_profile(&raw)).map(Arc::new);
        Self { path, locks: PathLocks::new(), cached: RwLock::new(cached) }
    }
}

impl UserProfileStore for FileUserProfileStore {
    fn get(&self) -> Option<Arc<UserProfile>> {
        self.cached.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn put(&self, profile: UserProfile) -> Result<Arc<UserProfile>, Error> {
        eos_contracts::check(&profile).map_err(|e| Error::Validation(e.message()))?;
        let content = serialize_user_profile(&profile)?;
        let _held = self.locks.lock(&self.path);
        atomic_write(&self.path, content.as_bytes(), &WriteOptions::default()).map_err(Error::storage)?;
        let profile = Arc::new(profile);
        *self.cached.write().unwrap_or_else(PoisonError::into_inner) = Some(profile.clone());
        Ok(profile)
    }
}

/// `JSON.stringify(profile, null, 2)` and a line feed.
pub fn serialize_user_profile(profile: &UserProfile) -> Result<String, Error> {
    let mut json = serde_json::to_string_pretty(profile).map_err(Error::storage)?;
    json.push('\n');
    Ok(json)
}

/// Reads `profile.json`. `None` when it is not JSON or not a profile.
pub fn parse_user_profile(raw: &str) -> Option<UserProfile> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    eos_contracts::parse(&value).ok()
}

const AVATAR_TYPES: [AvatarExt; 3] = [AvatarExt::Png, AvatarExt::Jpeg, AvatarExt::Webp];

fn ext_name(ext: AvatarExt) -> &'static str {
    match ext {
        AvatarExt::Png => "png",
        AvatarExt::Jpeg => "jpeg",
        AvatarExt::Webp => "webp",
    }
}

/// The avatar image: at most one `avatar.<ext>` file.
#[derive(Debug)]
pub struct FileUserAvatarStore {
    dir: PathBuf,
}

impl FileUserAvatarStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn file_of(&self, ext: AvatarExt) -> PathBuf {
        self.dir.join(format!("avatar.{}", ext_name(ext)))
    }

    fn remove_all_but(&self, keep: Option<AvatarExt>) -> Result<(), Error> {
        for ext in AVATAR_TYPES.into_iter().filter(|ext| Some(*ext) != keep) {
            match fs::remove_file(self.file_of(ext)) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(Error::storage(e)),
            }
        }
        Ok(())
    }
}

impl UserAvatarStore for FileUserAvatarStore {
    fn read(&self) -> Result<Option<UserAvatar>, Error> {
        for ext in AVATAR_TYPES {
            match fs::read(self.file_of(ext)) {
                Ok(bytes) => return Ok(Some(UserAvatar { bytes, ext })),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(Error::storage(e)),
            }
        }
        Ok(None)
    }

    fn write(&self, avatar: &UserAvatar) -> Result<(), Error> {
        atomic_write(&self.file_of(avatar.ext), &avatar.bytes, &WriteOptions::default()).map_err(Error::storage)?;
        self.remove_all_but(Some(avatar.ext))
    }

    fn remove(&self) -> Result<(), Error> {
        self.remove_all_but(None)
    }
}
