//! Reflection in the app: one task that reflects pending moments after each
//! capture that stored some and every ten minutes. A model is asked only when
//! the host allows background model calls, the user is signed in to a Claude
//! plan (never an API key alone, D23) and plan usage is under their dreaming
//! line; a chat on another provider's model is reflected by the rules only
//! (D24). Moments are read from the event log, or from a Code-view pane's
//! transcript.

use std::sync::Arc;

use eos_core::accounts::PlanAccess;
use eos_core::git::ProjectKeys;
use eos_core::profile::UserProfileReader;
use eos_core::routine::RunLookup;
use eos_core::store::{EventOrder, EventQuery, Store, StoredMoment, agent_caller};
use eos_core::{BoxFuture, Error, Sleeper};
use eos_domain::run_scope::Trust;
use eos_memory::merge::Place;
use eos_memory::{Gate, ModelGate, MomentContext, MomentSource, Recall, ReflectPrompt, Reflector};
use eos_prompts::PromptService;
use tokio::sync::Notify;

use crate::code::CodePanes;
use crate::hooks::TICK_MS;

/// The provider whose plan reflection runs on.
const PROVIDER: &str = "anthropic";
/// The backend kind of a session on Anthropic's models.
const CLAUDE: &str = "claude";
/// Rows read back from a moment's last row: room for twelve messages and
/// the activity between them.
const CONTEXT_ROWS: i64 = 200;

/// Asks the host and the profile whether a model may be asked now.
pub(crate) struct PlanGate {
    pub(crate) background_model_calls: bool,
    pub(crate) plan: Arc<dyn PlanAccess>,
    pub(crate) profile: Arc<dyn UserProfileReader>,
}

impl ModelGate for PlanGate {
    fn gate(&self) -> BoxFuture<'_, Gate> {
        Box::pin(async move {
            if !self.background_model_calls || self.plan.logins(PROVIDER).is_empty() {
                return Gate::RulesOnly;
            }
            let line = self.profile.get().dreaming.usage_ceiling.0;
            match self.plan.utilization(PROVIDER).await {
                Some(used) if used >= line => Gate::Wait,
                _ => Gate::Model,
            }
        })
    }
}

/// Reads a moment's conversation where it lives.
pub(crate) struct Moments {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) project_keys: Arc<dyn ProjectKeys>,
    pub(crate) runs: Option<Arc<dyn RunLookup>>,
    pub(crate) code: Option<Arc<CodePanes>>,
}

impl MomentSource for Moments {
    fn context<'a>(&'a self, moment: &'a StoredMoment) -> BoxFuture<'a, Result<Option<MomentContext>, Error>> {
        Box::pin(async move {
            if moment.source == "code" {
                let claude_session_id = moment.worker_id.trim_start_matches("pty:");
                let rows = match &self.code {
                    Some(code) => code.rows(claude_session_id).await,
                    None => None,
                };
                let Some((rows, cwd)) = rows else { return Ok(None) };
                let project = Some(self.project_keys.to_key(&cwd).await);
                return Ok(Some(MomentContext {
                    rows,
                    anthropic: true,
                    untrusted: false,
                    place: Place { routine: None, project },
                    project_path: Some(cwd),
                }));
            }
            let (worker, row_to) = (moment.worker_id.clone(), moment.row_to);
            let found = self
                .store
                .read(move |tx| {
                    let Some(caller) = agent_caller(tx.workers(), Some(&worker))? else { return Ok(None) };
                    let rows = tx.events().list(&EventQuery {
                        worker_id: worker.clone(),
                        since: 0,
                        limit: CONTEXT_ROWS,
                        order: EventOrder::Desc,
                        before_id: Some(row_to + 1),
                        after_id: None,
                    })?;
                    Ok(Some((caller, rows)))
                })
                .await?;
            let Some((caller, rows)) = found else { return Ok(None) };
            if rows.iter().all(|r| r.id < moment.row_from) {
                return Ok(None);
            }
            let project = match caller.project.as_deref() {
                Some(path) => Some(self.project_keys.to_key(path).await),
                None => None,
            };
            let run = match &self.runs {
                Some(runs) => runs.run_of(&moment.worker_id).await,
                None => None,
            };
            Ok(Some(MomentContext {
                rows,
                anthropic: caller.kind.as_deref().is_none_or(|kind| kind == CLAUDE),
                untrusted: run.as_ref().is_some_and(|r| r.trust == Trust::Untrusted),
                place: Place { routine: run.map(|r| r.routine_id), project },
                project_path: caller.project,
            }))
        })
    }
}

/// The reflection prompt from the library, so the user's override applies.
pub(crate) struct LibraryPrompt(pub(crate) Arc<PromptService>);

impl ReflectPrompt for LibraryPrompt {
    fn render(&self, signal: &str, transcript: &str, neighbours: &str) -> Result<(String, String), Error> {
        eos_prompts::templates::memory::reflect(&self.0, signal, transcript, neighbours)
    }
}

/// The one reflector task.
pub(crate) struct Reflecting {
    pub(crate) reflector: Reflector,
    pub(crate) recall: Arc<Recall>,
    pub(crate) wake: Arc<Notify>,
}

impl Reflecting {
    /// Reflects when woken and every ten minutes, until stopped.
    pub(crate) async fn run(self: Arc<Self>, sleeper: Arc<dyn Sleeper>) {
        loop {
            tokio::select! {
                () = sleeper.sleep(TICK_MS) => {}
                () = self.wake.notified() => {}
            }
            self.drain().await;
        }
    }

    async fn drain(&self) {
        loop {
            match self.reflector.pass().await {
                Ok(pass) => {
                    if pass.learned > 0
                        && let Err(e) = self.recall.embed_missing().await
                    {
                        tracing::warn!(error = %e, "memory: new notes were not embedded");
                    }
                    let done = pass.learned + pass.merged + pass.skipped + pass.failed;
                    if pass.waiting || done == 0 {
                        return;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "memory: reflection failed");
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use eos_contracts::UserProfile;
    use eos_domain::accounts::PlanLoginRecord;
    use eos_domain::user_profile::empty_user_profile;

    use super::*;

    struct Plan {
        signed_in: bool,
        used: Option<f64>,
    }

    impl PlanAccess for Plan {
        fn logins(&self, provider: &str) -> Vec<PlanLoginRecord> {
            let login = PlanLoginRecord {
                id: "pl-1".into(),
                provider: provider.into(),
                label: "Plan".into(),
                email: None,
                store_dir: "/tmp/none".into(),
                created_at: String::new(),
            };
            if self.signed_in { vec![login] } else { vec![] }
        }
        fn access_token<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Option<String>> {
            Box::pin(std::future::ready(None))
        }
        fn token_refused<'a>(&'a self, _: &'a str, _: &'a str, _: &'a str) -> BoxFuture<'a, bool> {
            Box::pin(std::future::ready(false))
        }
        fn login_of_worker(&self, _: &str, _: &str) -> Option<String> {
            None
        }
        fn utilization<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Option<f64>> {
            Box::pin(std::future::ready(self.used))
        }
    }

    struct Profile;

    impl UserProfileReader for Profile {
        fn get(&self) -> Arc<UserProfile> {
            Arc::new(empty_user_profile())
        }
    }

    async fn gate(background_model_calls: bool, signed_in: bool, used: Option<f64>) -> Gate {
        let plan = Arc::new(Plan { signed_in, used });
        PlanGate { background_model_calls, plan, profile: Arc::new(Profile) }.gate().await
    }

    #[tokio::test]
    async fn a_model_only_on_a_plan_under_the_line_in_the_installed_app() {
        let line = empty_user_profile().dreaming.usage_ceiling.0;
        assert_eq!(gate(true, true, Some(line - 0.1)).await, Gate::Model);
        assert_eq!(gate(true, true, None).await, Gate::Model);
        assert_eq!(gate(true, true, Some(line)).await, Gate::Wait, "at the dreaming line");
        assert_eq!(gate(true, false, None).await, Gate::RulesOnly, "an API key alone never pays for learning");
        assert_eq!(gate(false, true, None).await, Gate::RulesOnly, "a dev run or a test calls no model");
    }
}
