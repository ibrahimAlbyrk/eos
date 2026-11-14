//! The one write path for the user's profile. Every real change bumps `rev` and
//! announces `profile:change`; a save carrying a stale revision is refused with
//! the current profile instead of overwriting a change made in another window.
//! A save that changes nothing keeps the revision.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{AVATAR_MAX_BYTES, Num, UserProfile, UserProfileChangeEvent, UserProfilePatch};
use eos_core::Clock;
use eos_core::profile::{SyncedProfileFields, UserProfileReader, UserProfileSync};
use eos_core::store::{UserAvatar, UserAvatarStore, UserProfileStore};
use eos_domain::user_profile::{apply_profile_patch, empty_user_profile, same_profile_content, sniff_avatar_ext};
use eos_runtime::bus::Bus;

use crate::{Error, PROFILE_CHANGE};

pub struct UserProfileService {
    store: Arc<dyn UserProfileStore>,
    avatars: Arc<dyn UserAvatarStore>,
    clock: Arc<dyn Clock>,
    bus: Bus,
    /// One change at a time: the revision check, the write and the
    /// announcement are one step.
    changing: Mutex<()>,
}

impl std::fmt::Debug for UserProfileService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserProfileService").finish_non_exhaustive()
    }
}

impl UserProfileService {
    pub fn new(
        store: Arc<dyn UserProfileStore>,
        avatars: Arc<dyn UserAvatarStore>,
        clock: Arc<dyn Clock>,
        bus: Bus,
    ) -> Self {
        Self { store, avatars, clock, bus, changing: Mutex::new(()) }
    }

    fn change(&self) -> MutexGuard<'_, ()> {
        self.changing.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The saved profile, or the empty one.
    pub fn get(&self) -> Arc<UserProfile> {
        self.store.get().unwrap_or_else(|| Arc::new(empty_user_profile()))
    }

    pub fn update(&self, patch: &UserProfilePatch, base_rev: Option<i64>) -> Result<Arc<UserProfile>, Error> {
        let _changing = self.change();
        let cur = self.get();
        if base_rev.is_some_and(|rev| rev != cur.rev) {
            return Err(Error::StaleProfile(cur));
        }
        let next = apply_profile_patch(&cur, patch);
        if same_profile_content(&cur, &next) { Ok(cur) } else { Ok(self.commit(next)?) }
    }

    pub fn avatar(&self) -> Result<Option<UserAvatar>, eos_core::Error> {
        self.avatars.read()
    }

    /// Stores the image under the type its first bytes say it is.
    pub fn set_avatar(&self, bytes: &[u8]) -> Result<Arc<UserProfile>, eos_core::Error> {
        if bytes.is_empty() {
            return Err(eos_core::Error::Validation("empty image".into()));
        }
        if bytes.len() as u64 > AVATAR_MAX_BYTES.unsigned_abs() {
            return Err(eos_core::Error::Validation(format!(
                "image larger than {} MB",
                AVATAR_MAX_BYTES / (1024 * 1024)
            )));
        }
        let Some(ext) = sniff_avatar_ext(bytes) else {
            return Err(eos_core::Error::Validation("avatar must be a PNG, JPEG or WebP image".into()));
        };
        let _changing = self.change();
        self.avatars.write(&UserAvatar { bytes: bytes.to_vec(), ext })?;
        let mut next = UserProfile::clone(&self.get());
        next.identity.avatar = Some(ext);
        self.commit(next)
    }

    pub fn clear_avatar(&self) -> Result<Arc<UserProfile>, eos_core::Error> {
        let _changing = self.change();
        let cur = self.get();
        if cur.identity.avatar.is_none() {
            return Ok(cur);
        }
        self.avatars.remove()?;
        let mut next = UserProfile::clone(&cur);
        next.identity.avatar = None;
        self.commit(next)
    }

    /// Called with the change lock held.
    fn commit(&self, mut next: UserProfile) -> Result<Arc<UserProfile>, eos_core::Error> {
        next.rev = self.get().rev + 1;
        next.updated_at = Num::from(self.clock.now_ms());
        let saved = self.store.put(next)?;
        self.bus.publish(&PROFILE_CHANGE, &UserProfileChangeEvent { rev: saved.rev });
        Ok(saved)
    }
}

impl UserProfileReader for UserProfileService {
    fn get(&self) -> Arc<UserProfile> {
        UserProfileService::get(self)
    }
}

impl UserProfileSync for UserProfileService {
    fn get(&self) -> Arc<UserProfile> {
        UserProfileService::get(self)
    }

    fn apply_synced(&self, fields: SyncedProfileFields) -> Result<Arc<UserProfile>, eos_core::Error> {
        let _changing = self.change();
        let cur = UserProfileService::get(self);
        let mut next = UserProfile::clone(&cur);
        if let Some(identity) = fields.identity {
            next.identity.full_name = identity.full_name;
            next.identity.call_name = identity.call_name;
            next.identity.handle = identity.handle;
        }
        if let Some(language) = fields.language {
            next.language.chat = language.chat;
            next.language.code = language.code;
        }
        if let Some(work) = fields.work {
            next.work = work;
        }
        if let Some(style) = fields.style {
            next.style = style;
        }
        if let Some(instructions) = fields.instructions {
            next.instructions = instructions;
        }
        if let Some(sharing) = fields.sharing {
            next.sharing = sharing;
        }
        if let Some(budget_tokens) = fields.budget_tokens {
            next.budget_tokens = budget_tokens;
        }
        if let Some(onboarded_at) = fields.onboarded_at {
            next.onboarded_at = onboarded_at;
        }
        if same_profile_content(&cur, &next) { Ok(cur) } else { self.commit(next) }
    }

    fn avatar(&self) -> Result<Option<UserAvatar>, eos_core::Error> {
        UserProfileService::avatar(self)
    }

    fn set_avatar(&self, bytes: &[u8]) -> Result<Arc<UserProfile>, eos_core::Error> {
        UserProfileService::set_avatar(self, bytes)
    }

    fn clear_avatar(&self) -> Result<Arc<UserProfile>, eos_core::Error> {
        UserProfileService::clear_avatar(self)
    }
}
