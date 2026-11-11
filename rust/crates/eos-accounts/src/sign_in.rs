//! Browser sign-ins in flight, at most one per provider
//! (`manager/services/accounts/SignInService.ts`). A provider knows how to
//! run its official sign-in; this service owns the session the dashboard
//! polls: starting → waiting (sign-in page open) → succeeded | failed |
//! cancelled. A finished session lingers briefly so a late poll still sees
//! the end.
//!
//! A provider that holds several sign-ins signs in to a store
//! [`PlanLoginService`] prepares (a fresh one to add a sign-in, a listed
//! sign-in's own to renew it) and the sign-in is recorded there once it
//! succeeds.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use eos_contracts::{SignInSession, SignInState};
use eos_core::accounts::{Browser, PlanStores, SignInPages, SignInRequest, SignedIn, SubscriptionProvider};
use eos_core::store::ConfigSource;
use eos_core::{Error, Ids};
use serde_json::{Map, Value};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;

use crate::ledger::PlanLimitLedger;
use crate::logins::{PlanLoginService, SignInTarget};
use crate::plan::CLAUDE;
use crate::status::AccountsService;
use crate::usage::UsageService;

const KEEP_FINISHED: Duration = Duration::from_secs(5 * 60);
/// Sessions held at once; past it the finished ones go early.
const MAX_SESSIONS: usize = 32;

struct Entry {
    session: SignInSession,
    code: Option<oneshot::Sender<String>>,
    task: Option<AbortHandle>,
    target: Option<SignInTarget>,
}

fn active(session: &SignInSession) -> bool {
    matches!(session.state, SignInState::Starting | SignInState::Waiting)
}

pub(crate) struct SignInDeps {
    pub(crate) providers: Vec<Arc<dyn SubscriptionProvider>>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) logins: Arc<PlanLoginService>,
    pub(crate) ledger: Arc<PlanLimitLedger>,
    pub(crate) stores: Arc<dyn PlanStores>,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) browser: Arc<dyn Browser>,
    pub(crate) usage: Arc<UsageService>,
    pub(crate) status: Arc<AccountsService>,
}

pub struct SignInService {
    deps: SignInDeps,
    sessions: Mutex<HashMap<String, Entry>>,
}

impl std::fmt::Debug for SignInService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInService").finish_non_exhaustive()
    }
}

impl SignInService {
    pub(crate) fn new(deps: SignInDeps) -> Self {
        Self { deps, sessions: Mutex::default() }
    }

    fn sessions(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn provider(&self, id: &str) -> Option<&Arc<dyn SubscriptionProvider>> {
        self.deps.providers.iter().find(|p| p.id() == id)
    }

    pub fn supports(&self, provider: &str) -> bool {
        self.provider(provider).is_some()
    }

    pub fn holds_several(&self, provider: &str) -> bool {
        self.provider(provider).is_some_and(|p| p.multi_login())
    }

    /// The providers a user can sign in to.
    pub(crate) fn provider_ids(providers: &[Arc<dyn SubscriptionProvider>]) -> Vec<&'static str> {
        providers.iter().map(|p| p.id()).collect()
    }

    /// Starts a sign-in; one already under way for the provider is cancelled.
    /// `login_id` signs that sign-in in again; without it the sign-in adds one.
    pub fn start(self: &Arc<Self>, provider: &str, login_id: Option<&str>) -> Result<SignInSession, Error> {
        let Some(p) = self.provider(provider).cloned() else {
            return Err(Error::Rule(format!("sign-in is not supported for \"{provider}\"")));
        };
        let running: Vec<String> = self
            .sessions()
            .iter()
            .filter(|(_, e)| e.session.provider == provider && active(&e.session))
            .map(|(id, _)| id.clone())
            .collect();
        for id in running {
            self.cancel(&id);
        }

        let target = if p.multi_login() { Some(self.deps.logins.prepare(provider, login_id)?) } else { None };
        let renewal = target.as_ref().filter(|t| !t.fresh);
        let login_hint =
            renewal.and_then(|t| self.deps.logins.registry().find(provider, &t.login_id).and_then(|l| l.email.clone()));
        let store_dir =
            target.as_ref().map_or_else(|| self.deps.logins.single_store(provider), |t| t.store_dir.clone());

        let id = self.deps.ids.sign_in_id();
        let session = SignInSession {
            id: id.clone(),
            provider: provider.to_owned(),
            login_id: renewal.map(|t| t.login_id.clone()),
            state: SignInState::Starting,
            url: None,
            code_entry: Some(p.accepts_code()),
            error: None,
        };
        let (code_tx, code_rx) = oneshot::channel();
        {
            let mut sessions = self.sessions();
            if sessions.len() >= MAX_SESSIONS {
                sessions.retain(|_, e| active(&e.session));
            }
            sessions.insert(id.clone(), Entry { session: session.clone(), code: Some(code_tx), task: None, target });
        }

        let (pages_for, pages_id) = (self.clone(), id.clone());
        let flow = p.sign_in(SignInRequest {
            store_dir,
            login_hint,
            on_pages: Box::new(move |pages| pages_for.waiting(&pages_id, &pages)),
            code: Box::pin(async move { code_rx.await.ok() }),
        });
        let (this, task_id) = (self.clone(), id.clone());
        let task = tokio::spawn(async move {
            let result = flow.await;
            this.finished(&task_id, &p, result).await;
        });
        if let Some(entry) = self.sessions().get_mut(&id) {
            entry.task = Some(task.abort_handle());
        }
        Ok(session)
    }

    fn waiting(&self, id: &str, pages: &SignInPages) {
        {
            let mut sessions = self.sessions();
            let Some(entry) = sessions.get_mut(id).filter(|e| active(&e.session)) else { return };
            entry.session.state = SignInState::Waiting;
            entry.session.url = Some(pages.shown.clone());
        }
        self.deps.browser.open(&pages.open);
    }

    async fn finished(
        self: &Arc<Self>,
        id: &str,
        provider: &Arc<dyn SubscriptionProvider>,
        result: Result<SignedIn, String>,
    ) {
        let target = {
            let mut sessions = self.sessions();
            match sessions.get_mut(id).filter(|e| active(&e.session)) {
                Some(entry) => entry.target.clone(),
                None => return,
            }
        };
        let signed_in = match result {
            Ok(signed_in) => signed_in,
            Err(reason) => return self.fail(id, reason),
        };
        let mut replaced = None;
        if let Some(target) = &target {
            match self.deps.logins.commit(target, signed_in.email.as_deref()) {
                Ok(committed) => {
                    // Recorded: a later failure must not discard its store.
                    if let Some(entry) = self.sessions().get_mut(id) {
                        entry.target = None;
                    }
                    self.deps.ledger.clear(&committed.login.id);
                    replaced = committed.replaced;
                }
                Err(e) => return self.fail(id, format!("Couldn't save the sign-in: {e}")),
            }
        }
        if provider.id() == CLAUDE {
            self.clear_legacy_token();
        }
        // A fresh sign-in to an account that is already listed replaced that
        // sign-in's store. The new one is in place by now and nothing reads
        // the old one, so cleaning it up never fails the sign-in.
        if let Some(old) = replaced
            && self.deps.stores.sign_out(provider.id(), &old).await.is_ok()
        {
            self.deps.logins.trash_store(&old);
        }
        self.end(id, SignInState::Succeeded, None);
        self.changed();
    }

    pub fn get(&self, id: &str) -> Option<SignInSession> {
        self.sessions().get(id).map(|e| e.session.clone())
    }

    /// Hands the pasted code to the sign-in; false when none is waiting for one.
    pub fn submit_code(&self, id: &str, code: &str) -> bool {
        let sender = match self.sessions().get_mut(id).filter(|e| active(&e.session)) {
            Some(entry) => entry.code.take(),
            None => return false,
        };
        sender.is_some_and(|tx| tx.send(code.trim().to_owned()).is_ok())
    }

    pub fn cancel(self: &Arc<Self>, id: &str) -> bool {
        if !self.sessions().get(id).is_some_and(|e| active(&e.session)) {
            return false;
        }
        self.end(id, SignInState::Cancelled, None);
        true
    }

    /// Signs the provider out of every sign-in it holds.
    pub async fn sign_out(&self, provider: &str) -> Result<(), Error> {
        let Some(p) = self.provider(provider) else {
            return Err(Error::Rule(format!("sign-in is not supported for \"{provider}\"")));
        };
        if p.multi_login() {
            for login in self.deps.logins.list(provider) {
                self.deps.stores.sign_out(provider, &login.store_dir).await?;
                self.deps.logins.remove(provider, &login.id)?;
                self.deps.ledger.clear(&login.id);
            }
        } else {
            self.deps.stores.sign_out(provider, &self.deps.logins.single_store(provider)).await?;
        }
        if provider == CLAUDE {
            self.clear_legacy_token();
        }
        self.changed();
        Ok(())
    }

    pub async fn remove_login(&self, provider: &str, login_id: &str) -> Result<(), Error> {
        let login = self.deps.logins.registry().find(provider, login_id).cloned();
        // `remove` reports the unknown sign-in.
        if let Some(login) = &login {
            self.deps.stores.sign_out(provider, &login.store_dir).await?;
        }
        self.deps.logins.remove(provider, login_id)?;
        self.deps.ledger.clear(login_id);
        self.changed();
        Ok(())
    }

    /// The setup-token of an install from before sign-ins had stores is
    /// retired by a new sign-in and by a sign-out.
    fn clear_legacy_token(&self) {
        if self.deps.config.current().anthropic.auth_token.is_none() {
            return;
        }
        let patch = Map::from_iter([("authToken".to_owned(), Value::Null)]);
        if let Err(e) = self.deps.config.patch("anthropic", patch) {
            tracing::warn!(error = %e, "the old setup-token could not be cleared from config.json");
        }
    }

    /// A credential was saved or removed: account status and usage are stale.
    fn changed(&self) {
        self.deps.status.invalidate();
        self.deps.usage.invalidate();
    }

    fn fail(self: &Arc<Self>, id: &str, error: String) {
        self.end(id, SignInState::Failed, Some(error));
    }

    /// Ends a session: a sign-in that did not finish leaves no store behind,
    /// and the session is forgotten after the keep window.
    fn end(self: &Arc<Self>, id: &str, state: SignInState, error: Option<String>) {
        let (task, target) = {
            let mut sessions = self.sessions();
            let Some(entry) = sessions.get_mut(id) else { return };
            entry.session.state = state;
            entry.session.error = error;
            entry.code = None;
            (entry.task.take(), entry.target.take())
        };
        if state != SignInState::Succeeded {
            if let Some(task) = task {
                task.abort();
            }
            if let Some(target) = target {
                self.deps.logins.abandon(&target);
            }
        }
        let (this, id) = (self.clone(), id.to_owned());
        tokio::spawn(async move {
            tokio::time::sleep(KEEP_FINISHED).await;
            this.sessions().remove(&id);
        });
    }
}
