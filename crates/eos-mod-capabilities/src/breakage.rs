//! A capability that breaks (06 G10): while it needs a sign-in, a setup
//! step or a repair, is switched off or is gone, the routines that need it
//! are paused with the reason `capability:<id>`, and, unless the user
//! switched it off or removed it, one Needs-you item per capability says
//! what to do: sign in, set up, Repair (a Forge update run) or go back to
//! the version before. Once it works again the item is withdrawn and only
//! the routines paused for it resume. Settled on every `capabilities:change`
//! and for every capability once the app is ready.

use std::sync::{Arc, Mutex, PoisonError};

use eos_capabilities::{CAPABILITIES_CHANGE, CapabilityService};
use eos_contracts::CapabilitiesChange;
use eos_core::capability::CapabilityRegistry;
use eos_core::os::TimeZone;
use eos_core::routine::RoutineControl;
use eos_core::store::{Outbox, Store, StoredInstall, Tx};
use eos_core::{Clock, Error, Ids};
use eos_domain::capability::health::{HealthState, StateCode};
use eos_domain::inbox::{ItemKind, ItemState};
use eos_inbox::{NewItem, Opening, open_in};
use eos_runtime::bus::{Bus, RecvError};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

/// Who acts on the item: the card's buttons call this feature's routes.
pub const PRODUCER: &str = "capabilities";
/// How many changes wait for the watch.
const CHANGES_QUEUED: usize = 64;

/// Why the routines that need `capability_id` are paused, and the subject
/// of its one item.
pub fn pause_reason(capability_id: &str) -> String {
    format!("capability:{capability_id}")
}

/// What breaking a capability needs from the routines and the inbox.
pub struct BreakageParts {
    pub control: Arc<dyn RoutineControl>,
    pub ids: Arc<dyn Ids>,
    pub zone: Arc<dyn TimeZone>,
    pub bus: Bus,
}

impl std::fmt::Debug for BreakageParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BreakageParts").finish_non_exhaustive()
    }
}

pub(crate) struct Breakage {
    parts: BreakageParts,
    service: Arc<CapabilityService>,
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    watch: Mutex<Option<JoinHandle<()>>>,
}

/// Where a capability stands for the routines that need it.
#[derive(Debug, Clone, PartialEq)]
enum Standing {
    /// It takes calls: its routines may run.
    Works,
    /// Switched off, or gone: paused, nothing to ask.
    Off,
    /// Paused, with this item.
    Attention { title: String, summary: String, payload: Value },
}

fn works(state: HealthState) -> bool {
    matches!(state, HealthState::Ready | HealthState::Degraded)
}

/// The installed version to go back to: the newest one kept other than the
/// active one.
fn before_in(tx: &dyn Tx, install: &StoredInstall) -> Result<Option<String>, Error> {
    let Some(active) = &install.active_version else { return Ok(None) };
    let versions = tx.capability_versions().of_capability(&install.id)?;
    Ok(versions
        .into_iter()
        .filter(|version| version.status == "installed" && &version.version != active)
        .max_by_key(|version| version.activated_at)
        .map(|version| version.version))
}

/// The paused routines, as the user reads them.
fn paused_line(names: &[String]) -> String {
    match names {
        [] => "No routine needs it now.".to_owned(),
        [one] => format!("{one} is paused."),
        [one, two] => format!("{one} and {two} are paused."),
        [one, rest @ ..] => format!("{one} and {} other routines are paused.", rest.len()),
    }
}

fn standing_in(tx: &dyn Tx, id: &str, name: &str, users: &[String]) -> Result<Standing, Error> {
    let Some(install) = tx.capability_installs().find(id)? else { return Ok(Standing::Off) };
    let state = install.health.state;
    if works(state) {
        return Ok(Standing::Works);
    }
    if matches!(state, HealthState::Disabled | HealthState::Available) {
        return Ok(Standing::Off);
    }
    let mut names = Vec::new();
    for routine_id in users {
        if let Some(routine) = tx.routines().find(routine_id)? {
            names.push(routine.name);
        }
    }
    let code = install.health.code.as_ref().map(StateCode::as_string);
    let title = match state {
        HealthState::NeedsSignIn => format!("{name} needs you to sign in again"),
        HealthState::NeedsSetup => format!("{name} needs setting up"),
        _ => format!("{name} stopped working"),
    };
    let broken = state == HealthState::Broken;
    let go_back = if broken { before_in(tx, &install)? } else { None };
    // A built-in is Eos's own code: the Forge cannot build it again.
    let repair = broken && install.origin != "builtin";
    let payload = json!({
        "capabilityId": id,
        "state": state.as_str(),
        "stateCode": code,
        "repair": repair,
        "goBack": go_back,
        "routines": users,
    });
    Ok(Standing::Attention { title, summary: paused_line(&names), payload })
}

/// Withdraws the waiting items about `subject` that no longer apply;
/// answers whether one with `payload` still waits.
fn withdraw_in(tx: &dyn Tx, out: &mut Outbox, now: i64, subject: &str, keep: Option<&Value>) -> Result<bool, Error> {
    let mut kept = false;
    for mut item in tx.inbox_items().waiting_with_subject(subject)? {
        if item.kind != ItemKind::CapabilityAttention || item.producer != PRODUCER {
            continue;
        }
        let same =
            keep.is_some_and(|payload| serde_json::from_str::<Value>(&item.payload).ok().as_ref() == Some(payload));
        if same && !kept {
            kept = true;
            continue;
        }
        let rev = item.rev;
        item.state = ItemState::Withdrawn;
        item.rev += 1;
        item.updated_at = now;
        if tx.inbox_items().update_waiting(&item, rev)? {
            tracing::info!(item_id = %item.id, "a capability's item was withdrawn");
            eos_inbox::announce(tx, out, &item)?;
        }
    }
    Ok(kept)
}

impl Breakage {
    pub(crate) fn new(
        parts: BreakageParts,
        service: Arc<CapabilityService>,
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { parts, service, store, clock, watch: Mutex::new(None) }
    }

    /// Pauses or resumes the routines that need `id` and keeps its item as
    /// the capability now stands.
    pub(crate) async fn settle(&self, id: &str) -> Result<(), Error> {
        let users = self.parts.control.using_capability(id).await?;
        let name = self.service.get(id).await?.map_or_else(|| id.to_owned(), |capability| capability.manifest.name);
        let reason = pause_reason(id);
        let (control, ids, zone) = (self.parts.control.clone(), self.parts.ids.clone(), self.parts.zone.clone());
        let (owned, now) = (id.to_owned(), self.clock.now_ms());
        let reason_in = reason.clone();
        let standing = self
            .store
            .write(move |tx, out| {
                let standing = standing_in(tx, &owned, &name, &users)?;
                let payload = match &standing {
                    Standing::Attention { payload, .. } => Some(payload),
                    _ => None,
                };
                let waits = withdraw_in(tx, out, now, &reason_in, payload)?;
                if standing == Standing::Works {
                    return Ok(standing);
                }
                for routine_id in &users {
                    control.pause_in(tx, out, routine_id, &reason_in)?;
                }
                if let Standing::Attention { title, summary, payload } = standing.clone()
                    && !waits
                {
                    let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                    let new = NewItem {
                        kind: ItemKind::CapabilityAttention,
                        producer: PRODUCER.to_owned(),
                        routine_id: None,
                        run_id: None,
                        subject_key: Some(reason_in.clone()),
                        title,
                        summary,
                        payload,
                        by_hand: false,
                    };
                    open_in(tx, out, &at, new)?;
                    tracing::info!(capability = %owned, paused = users.len(), "a capability needs the user");
                }
                Ok(standing)
            })
            .await?;
        if standing == Standing::Works {
            self.parts.control.resume_paused(&reason).await?;
        }
        Ok(())
    }

    /// Settles every capability, then each one whose state changes.
    pub(crate) async fn start(self: &Arc<Self>) -> Result<(), Error> {
        let mut changes = self.parts.bus.subscribe(CAPABILITIES_CHANGE, CHANGES_QUEUED);
        for capability in self.service.list().await? {
            self.settle(&capability.id).await?;
        }
        // Weakly: a closed app lets its database go while this waits.
        let this = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            loop {
                let ids = match changes.recv().await {
                    Ok(event) => match event.payload_as::<CapabilitiesChange>() {
                        Ok(change) => vec![change.id],
                        Err(_) => continue,
                    },
                    // A missed change could leave a routine paused: settle them all.
                    Err(RecvError::Lagged(missed)) => {
                        tracing::debug!(missed, "capability changes were missed");
                        let Some(this) = this.upgrade() else { return };
                        match this.service.list().await {
                            Ok(all) => all.into_iter().map(|capability| capability.id).collect(),
                            Err(error) => {
                                tracing::warn!(%error, "the capabilities could not be read to settle them");
                                continue;
                            }
                        }
                    }
                    Err(RecvError::Closed) => return,
                };
                let Some(this) = this.upgrade() else { return };
                for id in ids {
                    if let Err(error) = this.settle(&id).await {
                        tracing::warn!(capability = %id, %error, "a capability's routines could not be settled");
                    }
                }
            }
        });
        if let Some(previous) = self.watch.lock().unwrap_or_else(PoisonError::into_inner).replace(task) {
            previous.abort();
        }
        Ok(())
    }

    pub(crate) async fn stop(&self) {
        let task = self.watch.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }
}
