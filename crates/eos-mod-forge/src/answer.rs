//! The user's side of a proposal (06 G9, G26), from this computer's
//! dashboard only: the live test they start and their word on whether it
//! reached them, Install, Decline, or another way. Install takes the files
//! whose hash was tested and reviewed, or nothing. Secrets the live test
//! needs are typed in the app's own prompt and kept in the Keychain; the
//! settings it needs are kept in memory for the install, never stored
//! before it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use eos_capabilities::{CapabilityService, Install};
use eos_contracts::{CapabilityProposal, ForgeBuild, LiveTest, ProposalChoice, ProposalState, RunInput};
use eos_core::Error;
use eos_core::capability::CapabilityRegistry;
use eos_core::forge::{ForgeCaller, ForgeRequest, ForgeStage};
use eos_core::shell::{SecretAsk, SecretPrompt};
use eos_core::store::{ItemAnswer, StoredItem};
use eos_domain::capability::manifest::Manifest;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::package::{Built, newest, read};
use crate::proposal::{PROPOSAL_EVENT, Proposed};
use crate::request::{ForgeService, report_event};
use crate::rollback::{back_if_young, failing};
use crate::steps::ForgeSteps;

/// The most live calls one proposal makes.
pub const LIVE_CALLS_MAX: u32 = 3;
/// What the live test says, for an action that takes text.
const LIVE_TEXT: &str = "Eos is testing a new capability. Did your phone alert you?";

pub(crate) struct Proposals {
    pub(crate) steps: Arc<ForgeSteps>,
    pub(crate) capabilities: Arc<CapabilityService>,
    pub(crate) prompt: Option<Arc<dyn SecretPrompt>>,
    pub(crate) forge: Arc<ForgeService>,
    /// The settings given for a run's live test, for its install.
    settings: Mutex<HashMap<String, BTreeMap<String, String>>>,
    live_calls: Mutex<HashMap<String, u32>>,
    /// Runs whose proposal is being acted on.
    busy: Mutex<HashSet<String>>,
}

/// Holds a run's proposal while one answer acts on it.
struct Busy<'a>(&'a Proposals, String);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.busy.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.1);
    }
}

impl Proposals {
    pub(crate) fn new(
        steps: Arc<ForgeSteps>,
        capabilities: Arc<CapabilityService>,
        prompt: Option<Arc<dyn SecretPrompt>>,
        forge: Arc<ForgeService>,
    ) -> Self {
        Self {
            steps,
            capabilities,
            prompt,
            forge,
            settings: Mutex::default(),
            live_calls: Mutex::default(),
            busy: Mutex::default(),
        }
    }

    fn hold(&self, run_id: &str) -> Result<Busy<'_>, Error> {
        if !self.busy.lock().unwrap_or_else(PoisonError::into_inner).insert(run_id.to_owned()) {
            return Err(Error::Conflict("this proposal is being answered already".into()));
        }
        Ok(Busy(self, run_id.to_owned()))
    }

    /// The run's proposal and its item.
    pub(crate) async fn state(&self, run_id: &str) -> Result<(StoredItem, ProposalState), Error> {
        let proposed = newest::<Proposed>(self.steps.store.as_ref(), run_id, PROPOSAL_EVENT).await?;
        let proposed = proposed.ok_or_else(|| Error::not_found("proposal", run_id))?;
        let id = proposed.item_id.clone();
        let item = self.steps.store.read(move |tx| tx.inbox_items().find(&id)).await?;
        let item = item.ok_or_else(|| Error::not_found("proposal", run_id))?;
        let proposal: CapabilityProposal = serde_json::from_str(&item.payload).map_err(Error::storage)?;
        let state = ProposalState { item_id: item.id.clone(), state: item.state.as_str().to_owned(), proposal };
        Ok((item, state))
    }

    async fn waiting(&self, run_id: &str) -> Result<(StoredItem, CapabilityProposal), Error> {
        let (item, state) = self.state(run_id).await?;
        if !item.state.is_waiting() {
            return Err(Error::Conflict("this proposal was answered already".into()));
        }
        Ok((item, state.proposal))
    }

    /// The package as it is now, refused unless its files are the proposed ones.
    async fn proposed_files(&self, run_id: &str, proposal: &CapabilityProposal) -> Result<Built, Error> {
        let build = newest::<ForgeBuild>(self.steps.store.as_ref(), run_id, &report_event(ForgeStage::Build)).await?;
        let build = build.ok_or_else(|| Error::Conflict("the package's report is gone".into()))?;
        let built = read(&self.steps, run_id, &build).await?.map_err(Error::Conflict)?;
        if built.hash != proposal.hash {
            return Err(Error::Conflict("the package changed since it was tested and reviewed; nothing ran".into()));
        }
        Ok(built)
    }

    /// Writes the proposal back into its item, one rev up.
    async fn retell(&self, mut item: StoredItem, proposal: &CapabilityProposal) -> Result<(), Error> {
        let rev = item.rev;
        item.payload = serde_json::to_string(proposal).map_err(Error::storage)?;
        item.rev += 1;
        item.updated_at = self.steps.clock.now_ms();
        self.steps
            .store
            .write(move |tx, out| {
                if !tx.inbox_items().retell(&item, rev)? {
                    return Err(Error::Conflict("the proposal changed meanwhile".into()));
                }
                eos_inbox::announce(tx, out, &item)
            })
            .await
    }

    /// The live call of the package's `tests.live`, with `settings`; a
    /// secret it needs is asked in the app's prompt first.
    pub(crate) async fn live_test(&self, run_id: &str, settings: BTreeMap<String, String>) -> Result<LiveTest, Error> {
        let _held = self.hold(run_id)?;
        let (item, mut proposal) = self.waiting(run_id).await?;
        let Some(live) = proposal.live_test.clone() else {
            return Err(Error::Conflict("this package has no live test".into()));
        };
        let calls = *self.live_calls.lock().unwrap_or_else(PoisonError::into_inner).get(run_id).unwrap_or(&0);
        if calls >= LIVE_CALLS_MAX {
            return Err(Error::LimitExceeded(format!("at most {LIVE_CALLS_MAX} live tests for one proposal")));
        }
        let built = self.proposed_files(run_id, &proposal).await?;
        let manifest = &built.manifest;
        let mut env = given(manifest, &settings)?;
        env.extend(self.secrets_for(manifest).await?);
        let input = live_input(manifest, &live.action)?;
        self.live_calls.lock().unwrap_or_else(PoisonError::into_inner).insert(run_id.to_owned(), calls + 1);
        let answer = self.steps.trial.live(&built.dir, manifest, input, env, &self.steps.tests_folder()).await;
        let state = if answer.is_ok() { "sent" } else { "failed" };
        tracing::info!(run_id, state, "a proposal's live test ran");
        self.settings.lock().unwrap_or_else(PoisonError::into_inner).insert(run_id.to_owned(), settings);
        let live = LiveTest { action: live.action, state: state.into() };
        proposal.live_test = Some(live.clone());
        self.retell(item, &proposal).await?;
        Ok(live)
    }

    /// Each secret the package declares, asked in the app's prompt when the
    /// Keychain has none for it yet.
    async fn secrets_for(&self, manifest: &Manifest) -> Result<Vec<(String, Zeroizing<String>)>, Error> {
        let secrets = self.capabilities.secrets();
        let mut env = Vec::new();
        for secret in &manifest.secrets {
            if !secrets.has(&manifest.id, &secret.name).await? {
                let Some(prompt) = &self.prompt else {
                    return Err(Error::Conflict("the secret prompt needs the app's window".into()));
                };
                let ask = SecretAsk {
                    capability: manifest.name.clone(),
                    label: secret.label.clone(),
                    help: secret.help.clone(),
                };
                let Some(value) = prompt.ask(ask).await.filter(|value| !value.trim().is_empty()) else {
                    return Err(Error::Conflict(format!("{} was not entered", secret.label)));
                };
                secrets.write(&manifest.id, &secret.name, value).await?;
                tracing::info!(capability = %manifest.id, "a proposed capability's secret was entered");
            }
            if let (Some(variable), Some(value)) = (&secret.env, secrets.read(&manifest.id, &secret.name).await?) {
                env.push((variable.clone(), value));
            }
        }
        Ok(env)
    }

    pub(crate) async fn answer(&self, run_id: &str, choice: ProposalChoice) -> Result<ProposalState, Error> {
        let held = self.hold(run_id)?;
        let (item, mut proposal) = self.waiting(run_id).await?;
        match choice {
            ProposalChoice::Alerted | ProposalChoice::NotAlerted => {
                let Some(live) = proposal.live_test.as_mut().filter(|live| live.state != "not_run") else {
                    return Err(Error::Conflict("send the live test first".into()));
                };
                live.state = if choice == ProposalChoice::Alerted { "alerted" } else { "not_alerted" }.into();
                self.retell(item, &proposal).await?;
            }
            ProposalChoice::Install => self.install(run_id, &item, &proposal).await?,
            ProposalChoice::Decline => self.decline(run_id, &item, &proposal, "decline").await?,
            ProposalChoice::OtherWay => {
                self.decline(run_id, &item, &proposal, "other_way").await?;
                drop(held);
                self.other_way(run_id, &proposal).await?;
            }
        }
        Ok(self.state(run_id).await?.1)
    }

    async fn install(&self, run_id: &str, item: &StoredItem, proposal: &CapabilityProposal) -> Result<(), Error> {
        if proposal.live_test.as_ref().is_some_and(|live| live.state != "alerted") {
            return Err(Error::Conflict("send the live test and say it reached you before installing".into()));
        }
        let built = self.proposed_files(run_id, proposal).await?;
        let id = built.manifest.id.clone();
        self.capabilities
            .install(Install {
                package_dir: built.dir,
                manifest: built.manifest,
                hash: proposal.hash.clone(),
                origin: crate::proposal::PRODUCER.to_owned(),
                source: crate::proposal::source_of(proposal, run_id),
            })
            .await?;
        tracing::info!(run_id, capability = %id, "a proposed capability was installed on the user's yes");
        let settings = self.settings.lock().unwrap_or_else(PoisonError::into_inner).remove(run_id);
        if let Some(settings) = settings.filter(|settings| !settings.is_empty()) {
            self.capabilities.set_settings(&id, settings.into_iter().collect()).await?;
        }
        self.settle(item, "install").await?;
        // The first check runs while the user is here, so an OS prompt shows now.
        let health = self.capabilities.check(&id).await?;
        if failing(health.state, health.code.as_ref()) {
            back_if_young(&self.steps, &self.capabilities, &id).await?;
        }
        Ok(())
    }

    async fn decline(
        &self,
        run_id: &str,
        item: &StoredItem,
        proposal: &CapabilityProposal,
        choice: &str,
    ) -> Result<(), Error> {
        self.settle(item, choice).await?;
        let (id, version) = (proposal.capability_id.clone(), proposal.version.clone());
        self.steps
            .store
            .write(move |tx, _| {
                let proposed =
                    tx.capability_versions().find(&id, &version)?.filter(|v| v.status == crate::proposal::PROPOSED);
                if proposed.is_some() {
                    tx.capability_versions().set_status(&id, &version, "rejected", None, None)?;
                }
                Ok(())
            })
            .await?;
        // A capability that is not installed keeps no secret entered for its proposal.
        if self.capabilities.get(&proposal.capability_id).await?.is_none() {
            let secrets = self.capabilities.secrets();
            for secret in &proposal.secrets {
                secrets.delete(&proposal.capability_id, &secret.name).await?;
            }
        }
        self.settings.lock().unwrap_or_else(PoisonError::into_inner).remove(run_id);
        tracing::info!(run_id, choice, "a proposal was declined");
        Ok(())
    }

    /// A new Forge run for the same need, not this way.
    async fn other_way(&self, run_id: &str, proposal: &CapabilityProposal) -> Result<(), Error> {
        let id = run_id.to_owned();
        let input = self.steps.store.read(move |tx| Ok(tx.runs().find(&id)?.map(|run| run.input))).await?;
        let input: Option<RunInput> = input.and_then(|text| serde_json::from_str(&text).ok());
        let need = input.and_then(|input| input.note).unwrap_or_default();
        let need = format!("{need}\n\nNot through {}: it did not work for the user. Find another way.", proposal.name);
        let routine_id = proposal.routines.first().map(|routine| routine.id.clone());
        let request =
            ForgeRequest { need, routine_id, capability_id: None, from_surface: None, caller: ForgeCaller::User };
        self.forge.request(request).await.map(drop)
    }

    /// Marks the item answered by this computer's dashboard.
    async fn settle(&self, item: &StoredItem, choice: &str) -> Result<(), Error> {
        let answer = ItemAnswer {
            by: "dashboard".into(),
            answer: Some(json!({"kind": "capability_install", "choice": choice}).to_string()),
            at: self.steps.clock.now_ms(),
        };
        let (id, rev) = (item.id.clone(), item.rev);
        let settled = self.steps.store.write(move |tx, out| eos_inbox::answer_in(tx, out, &id, rev, &answer)).await?;
        settled.map(drop).map_err(|_| Error::Conflict("the proposal changed meanwhile".into()))
    }
}

/// The settings given for the live test, each in its variable; a required
/// one missing or one the package does not declare is refused.
fn given(manifest: &Manifest, settings: &BTreeMap<String, String>) -> Result<Vec<(String, Zeroizing<String>)>, Error> {
    if let Some(unknown) = settings.keys().find(|name| !manifest.settings.iter().any(|s| &s.name == *name)) {
        return Err(Error::Validation(format!("settings: {unknown} is not one of the package's")));
    }
    let mut env = Vec::new();
    for setting in &manifest.settings {
        match settings.get(&setting.name).map(|value| value.trim()).filter(|value| !value.is_empty()) {
            Some(value) => env.push((setting.env(), Zeroizing::new(value.to_owned()))),
            None if setting.required => {
                return Err(Error::Validation(format!("settings: {} is needed", setting.label)));
            }
            None => {}
        }
    }
    Ok(env)
}

/// The live call's input: every text its action requires says it is a test.
fn live_input(manifest: &Manifest, action: &str) -> Result<Value, Error> {
    let action = manifest.action(action).ok_or_else(|| Error::not_found("action", action))?;
    let Some(schema) = &action.input else { return Ok(json!({})) };
    let mut input = serde_json::Map::new();
    for name in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let field = &schema["properties"][name];
        if field["type"] != "string" {
            return Err(Error::Conflict(format!("Eos cannot make the live test's input {name}")));
        }
        let max = field["maxLength"].as_u64().map_or(usize::MAX, |max| usize::try_from(max).unwrap_or(usize::MAX));
        input.insert(name.to_owned(), LIVE_TEXT.chars().take(max).collect::<String>().into());
    }
    Ok(Value::Object(input))
}
