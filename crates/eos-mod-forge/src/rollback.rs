//! A version the Forge installed whose health fails within a day of its
//! install goes back to the version before it, and the user is told with a
//! notice (06 G9). A first version has nothing to go back to: it stays, and
//! its problem shows on the capability.

use std::sync::Arc;

use eos_capabilities::CapabilityService;
use eos_core::Error;
use eos_core::capability::CapabilityRegistry;
use eos_core::store::StoredCapabilityVersion;
use eos_domain::capability::health::{HealthState, StateCode};
use eos_domain::inbox::ItemKind;
use eos_inbox::{NewItem, Opening, notice_in};
use serde_json::json;

use crate::proposal::PRODUCER;
use crate::steps::ForgeSteps;

/// How long after its install a failing version goes back by itself.
pub const ROLLBACK_WITHIN_MS: i64 = 24 * 60 * 60 * 1000;
/// The subject of the notice that says so.
pub const ROLLED_BACK: &str = "capability-rolled-back";

/// Whether a capability in `state` with `code` failed its health.
pub(crate) fn failing(state: HealthState, code: Option<&StateCode>) -> bool {
    state == HealthState::Broken || code == Some(&StateCode::HealthFailed)
}

/// Goes back to the version before the active one of `id` when the Forge
/// installed it less than [`ROLLBACK_WITHIN_MS`] ago; answers the version
/// it went back to.
pub(crate) async fn back_if_young(
    steps: &ForgeSteps,
    capabilities: &Arc<CapabilityService>,
    id: &str,
) -> Result<Option<String>, Error> {
    let now = steps.clock.now_ms();
    let owned = id.to_owned();
    let found = steps
        .store
        .read(move |tx| {
            let Some(install) = tx.capability_installs().find(&owned)? else { return Ok(None) };
            let Some(active) = install.active_version.clone() else { return Ok(None) };
            if install.origin != PRODUCER {
                return Ok(None);
            }
            let versions = tx.capability_versions().of_capability(&owned)?;
            let young = versions
                .iter()
                .find(|version| version.version == active)
                .and_then(|version| version.activated_at)
                .is_some_and(|at| now - at < ROLLBACK_WITHIN_MS);
            let before: Option<StoredCapabilityVersion> = versions
                .into_iter()
                .filter(|version| version.status == "installed" && version.version != active)
                .max_by_key(|version| version.activated_at);
            Ok(young.then_some(()).and(before).map(|before| (active, before.version)))
        })
        .await?;
    let Some((failed, before)) = found else { return Ok(None) };
    capabilities.rollback(id, &before).await?;
    tracing::info!(capability = id, "a failing new version went back to the one before");
    let name = capabilities.get(id).await?.map_or_else(|| id.to_owned(), |capability| capability.manifest.name);
    let (ids, zone, control) = (steps.ids.clone(), steps.zone.clone(), steps.control()?);
    let new = NewItem {
        kind: ItemKind::Notice,
        producer: PRODUCER.to_owned(),
        routine_id: None,
        run_id: None,
        subject_key: Some(ROLLED_BACK.to_owned()),
        title: format!("{name} went back to version {before}"),
        summary: format!(
            "Version {failed} failed its health check within a day of being installed, so Eos went back to {before}."
        ),
        payload: json!({"capabilityId": id, "failed": failed, "version": before}),
        by_hand: false,
    };
    steps
        .store
        .write(move |tx, out| {
            let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
            notice_in(tx, out, &at, new).map(drop)
        })
        .await?;
    Ok(Some(before))
}
