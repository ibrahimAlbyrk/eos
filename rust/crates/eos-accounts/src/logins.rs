//! The one write path for a provider's plan sign-ins
//! (`core/src/services/PlanLoginService.ts`). A sign-in writes into a store
//! folder prepared here: a fresh one to add a sign-in, the sign-in's own to
//! renew it. Once it succeeds, [`commit`](PlanLoginService::commit) records it:
//! a fresh sign-in to an account that is already listed (same email) takes
//! that sign-in's place, and the store it replaced is handed back so the
//! caller can sign it out before it is trashed.

use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::accounts::{PlanLoginDirs, PlanLoginStore};
use eos_core::{Clock, Error, Ids};
use eos_domain::accounts::{PlanLoginRecord, PlanLoginRegistry, default_login_label};
use eos_domain::time::iso_from_ms;

/// Where a sign-in in flight writes: a new sign-in's fresh store, or the
/// store of the sign-in it renews.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInTarget {
    pub provider: String,
    pub login_id: String,
    pub store_dir: String,
    pub fresh: bool,
}

/// What [`PlanLoginService::commit`] recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    pub login: PlanLoginRecord,
    /// The store this sign-in took the place of.
    pub replaced: Option<String>,
}

pub struct PlanLoginService {
    store: Arc<dyn PlanLoginStore>,
    dirs: Arc<dyn PlanLoginDirs>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    registry: Mutex<PlanLoginRegistry>,
}

impl std::fmt::Debug for PlanLoginService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlanLoginService").finish_non_exhaustive()
    }
}

fn clean(email: Option<&str>) -> Option<String> {
    email.map(str::trim).filter(|e| !e.is_empty()).map(str::to_owned)
}

impl PlanLoginService {
    pub fn new(
        store: Arc<dyn PlanLoginStore>,
        dirs: Arc<dyn PlanLoginDirs>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
    ) -> Self {
        let registry = Mutex::new(store.load());
        Self { store, dirs, clock, ids, registry }
    }

    fn lock(&self) -> MutexGuard<'_, PlanLoginRegistry> {
        self.registry.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The registry as it is now: the rules of `eos-domain` read it.
    pub fn registry(&self) -> PlanLoginRegistry {
        self.lock().clone()
    }

    /// The store of a provider that holds one sign-in.
    pub fn single_store(&self, provider: &str) -> String {
        self.dirs.single(provider)
    }

    pub fn list(&self, provider: &str) -> Vec<PlanLoginRecord> {
        self.lock().logins_of(provider).cloned().collect()
    }

    /// Saves `next` and makes it current; the lock is held, so two changes
    /// never interleave.
    fn save(&self, current: &mut MutexGuard<'_, PlanLoginRegistry>, next: PlanLoginRegistry) -> Result<(), Error> {
        self.store.save(&next)?;
        **current = next;
        Ok(())
    }

    fn get(registry: &PlanLoginRegistry, provider: &str, id: &str) -> Result<PlanLoginRecord, Error> {
        registry.find(provider, id).cloned().ok_or_else(|| Error::not_found("sign-in", id))
    }

    pub fn set_auto_switch(&self, provider: &str, enabled: bool) -> Result<(), Error> {
        let mut current = self.lock();
        let next = current.clone().with_auto_switch(provider, enabled);
        self.save(&mut current, next)
    }

    pub fn prepare(&self, provider: &str, login_id: Option<&str>) -> Result<SignInTarget, Error> {
        if let Some(id) = login_id {
            let login = Self::get(&self.lock(), provider, id)?;
            return Ok(SignInTarget {
                provider: provider.to_owned(),
                login_id: login.id,
                store_dir: login.store_dir,
                fresh: false,
            });
        }
        let id = self.ids.plan_login_id();
        let store_dir = self.dirs.create(provider, &id)?;
        Ok(SignInTarget { provider: provider.to_owned(), login_id: id, store_dir, fresh: true })
    }

    pub fn commit(&self, target: &SignInTarget, email: Option<&str>) -> Result<Committed, Error> {
        let email = clean(email);
        let mut current = self.lock();
        if !target.fresh {
            if let Some(email) = &email {
                let next = current.clone().with_login_changed(&target.login_id, |l| l.email = Some(email.clone()));
                self.save(&mut current, next)?;
            }
            return Ok(Committed { login: Self::get(&current, &target.provider, &target.login_id)?, replaced: None });
        }
        let same = email.as_deref().and_then(|e| current.find_by_email(&target.provider, e)).cloned();
        if let Some(same) = same {
            let next = current.clone().with_login_changed(&same.id, |l| l.store_dir.clone_from(&target.store_dir));
            self.save(&mut current, next)?;
            let login = Self::get(&current, &target.provider, &same.id)?;
            return Ok(Committed { login, replaced: Some(same.store_dir) });
        }
        let login = self.add(&mut current, &target.provider, &target.login_id, &target.store_dir, email)?;
        Ok(Committed { login, replaced: None })
    }

    /// A sign-in that did not finish leaves nothing behind.
    pub fn abandon(&self, target: &SignInTarget) {
        if target.fresh {
            self.dirs.discard(&target.store_dir);
        }
    }

    /// The caller signs the sign-in out of its store first.
    pub fn remove(&self, provider: &str, id: &str) -> Result<PlanLoginRecord, Error> {
        let mut current = self.lock();
        let login = Self::get(&current, provider, id)?;
        let next = current.clone().without_login(id);
        self.save(&mut current, next)?;
        drop(current);
        self.trash_store(&login.store_dir);
        Ok(login)
    }

    pub fn rename(&self, provider: &str, id: &str, label: &str) -> Result<PlanLoginRecord, Error> {
        let mut current = self.lock();
        Self::get(&current, provider, id)?;
        let next = current.clone().with_login_changed(id, |l| l.label = label.trim().to_owned());
        self.save(&mut current, next)?;
        Self::get(&current, provider, id)
    }

    pub fn set_default(&self, provider: &str, id: &str) -> Result<(), Error> {
        let mut current = self.lock();
        Self::get(&current, provider, id)?;
        let next = current.clone().with_default_login(provider, id);
        self.save(&mut current, next)
    }

    /// A store that was signed out (or replaced by another). Nothing reads it
    /// any more, so one that cannot be moved aside is only reported.
    pub fn trash_store(&self, store_dir: &str) {
        if let Err(e) = self.dirs.trash(store_dir) {
            tracing::warn!(error = %e, "a signed-out store could not be moved to the trash; left in place");
        }
    }

    /// The provider's sign-in from before it could hold several becomes its
    /// first one, in place: its store (and the credential keyed to that
    /// folder) stays put. Only while the provider lists none.
    pub fn adopt(
        &self,
        provider: &str,
        store_dir: &str,
        email: Option<&str>,
    ) -> Result<Option<PlanLoginRecord>, Error> {
        let mut current = self.lock();
        if current.logins_of(provider).next().is_some() {
            return Ok(None);
        }
        let id = self.ids.plan_login_id();
        self.add(&mut current, provider, &id, store_dir, clean(email)).map(Some)
    }

    fn add(
        &self,
        current: &mut MutexGuard<'_, PlanLoginRegistry>,
        provider: &str,
        id: &str,
        store_dir: &str,
        email: Option<String>,
    ) -> Result<PlanLoginRecord, Error> {
        let login = PlanLoginRecord {
            id: id.to_owned(),
            provider: provider.to_owned(),
            label: default_login_label(email.as_deref(), current.logins_of(provider).count()),
            email,
            store_dir: store_dir.to_owned(),
            created_at: iso_from_ms(self.clock.now_ms()),
        };
        let next = current.clone().with_login(login.clone());
        self.save(current, next)?;
        Ok(login)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use eos_testkit::{FakeClock, FakePlanLoginDirs, FakePlanLoginStore, SeqIds};

    pub(crate) struct Fixture {
        pub(crate) svc: Arc<PlanLoginService>,
        pub(crate) dirs: Arc<FakePlanLoginDirs>,
        pub(crate) store: Arc<FakePlanLoginStore>,
    }

    pub(crate) fn fixture() -> Fixture {
        let (store, dirs) = (Arc::new(FakePlanLoginStore::default()), Arc::new(FakePlanLoginDirs::default()));
        let svc = Arc::new(PlanLoginService::new(
            store.clone(),
            dirs.clone(),
            Arc::new(FakeClock::at(1_767_259_800_125)),
            Arc::new(SeqIds::new()),
        ));
        Fixture { svc, dirs, store }
    }

    impl Fixture {
        pub(crate) fn add(&self, email: Option<&str>) -> PlanLoginRecord {
            let target = self.svc.prepare("anthropic", None).expect("a fresh store");
            self.svc.commit(&target, email).expect("commits").login
        }
    }

    // core/src/__tests__/PlanLoginService.test.ts
    #[test]
    fn sign_ins_are_recorded_in_order_and_the_first_is_the_default() {
        let t = fixture();
        let (a, b) = (t.add(Some("a@example.com")), t.add(None));
        assert_eq!((a.label.as_str(), b.label.as_str()), ("a@example.com", "Account 2"));
        assert_eq!(a.created_at, "2026-01-01T09:30:00.125Z");
        assert_eq!(a.store_dir, format!("/acc/claude-{}", a.id));
        assert_eq!(t.svc.list("anthropic"), [a.clone(), b]);
        assert_eq!(t.svc.registry().default_login("anthropic").map(|l| l.id.clone()), Some(a.id));
        assert_eq!(t.store.saved().logins.len(), 2, "every change is saved");
        assert!(t.svc.list("openai").is_empty());
    }

    #[test]
    fn an_abandoned_fresh_sign_in_discards_its_store_and_a_renewal_keeps_it() {
        let t = fixture();
        let fresh = t.svc.prepare("anthropic", None).expect("a fresh store");
        t.svc.abandon(&fresh);
        assert_eq!(t.dirs.discarded(), [fresh.store_dir]);

        let a = t.add(None);
        let renewal = t.svc.prepare("anthropic", Some(&a.id)).expect("the sign-in's own store");
        assert_eq!((renewal.store_dir.as_str(), renewal.fresh), (a.store_dir.as_str(), false));
        t.svc.abandon(&renewal);
        assert_eq!(t.dirs.discarded().len(), 1, "a listed sign-in's store is never discarded");
    }

    #[test]
    fn renewing_records_the_email_it_signed_in_with() {
        let t = fixture();
        let a = t.add(None);
        let target = t.svc.prepare("anthropic", Some(&a.id)).expect("renewal");
        let done = t.svc.commit(&target, Some("me@example.com")).expect("commits");
        assert_eq!(done.login.email.as_deref(), Some("me@example.com"));
        assert_eq!(done.login.label, "Account 1", "the label the user sees stays");
        assert_eq!(done.replaced, None);
    }

    #[test]
    fn a_fresh_sign_in_to_a_listed_email_takes_that_sign_ins_place() {
        let t = fixture();
        let a = t.add(Some("me@example.com"));
        let target = t.svc.prepare("anthropic", None).expect("a fresh store");
        let done = t.svc.commit(&target, Some("Me@Example.com ")).expect("commits");
        assert_eq!(done.login.id, a.id, "the same sign-in");
        assert_eq!(done.login.store_dir, target.store_dir, "in the new store");
        assert_eq!(done.replaced.as_deref(), Some(a.store_dir.as_str()));
        assert_eq!(t.svc.list("anthropic").len(), 1);
    }

    #[test]
    fn removing_the_default_hands_it_on_and_trashes_the_store() {
        let t = fixture();
        let (a, b) = (t.add(None), t.add(None));
        t.svc.set_auto_switch("anthropic", false).expect("saves");
        let gone = t.svc.remove("anthropic", &a.id).expect("removes");
        assert_eq!(gone.id, a.id);
        assert_eq!(t.dirs.trashed(), [a.store_dir]);
        let reg = t.svc.registry();
        assert_eq!(reg.default_login("anthropic").map(|l| l.id.clone()), Some(b.id.clone()));
        assert!(!reg.auto_switch("anthropic"));

        t.svc.rename("anthropic", &b.id, "  Work ").expect("renames");
        assert_eq!(t.svc.list("anthropic")[0].label, "Work");
    }

    #[test]
    fn unknown_sign_ins_are_not_found_also_across_providers() {
        let t = fixture();
        let a = t.add(None);
        let missing = Error::not_found("sign-in", "nope");
        assert_eq!(t.svc.remove("anthropic", "nope"), Err(missing.clone()));
        assert_eq!(t.svc.rename("anthropic", "nope", "x"), Err(missing.clone()));
        assert_eq!(t.svc.set_default("anthropic", "nope"), Err(missing.clone()));
        assert_eq!(t.svc.prepare("anthropic", Some("nope")), Err(missing));
        assert_eq!(t.svc.set_default("openai", &a.id), Err(Error::not_found("sign-in", a.id.clone())));
        assert_eq!(missing_message(), "sign-in not found: nope");
    }

    fn missing_message() -> String {
        Error::not_found("sign-in", "nope").to_string()
    }

    #[test]
    fn the_sign_in_from_before_is_adopted_only_while_none_is_listed() {
        let t = fixture();
        let adopted =
            t.svc.adopt("anthropic", "/acc/claude", Some(" me@example.com ")).expect("saves").expect("adopted");
        assert_eq!((adopted.store_dir.as_str(), adopted.label.as_str()), ("/acc/claude", "me@example.com"));
        assert_eq!(t.svc.adopt("anthropic", "/acc/claude", None), Ok(None));
        assert_eq!(t.svc.list("anthropic").len(), 1);
    }
}
