//! What capability actions a run session may call (06 G16, 03 §7, D73):
//! every action of the capabilities its version needs, an agent that reads
//! outside text's too. Each one that reaches past this computer passes the
//! gate under the routine's Freedom ([`super::gate::action`]). The checker
//! only reads: it judges the result, it does not act. Outside runs there is
//! no grant of its own: a chat calls every installed action.

use std::sync::Arc;

use eos_contracts::ActionClass;
use eos_core::BoxFuture;
use eos_core::capability::{CapabilityGrants, Grant, GrantedAction, RunAction, RunActionDecision};
use eos_domain::run_scope::RunRole;

use super::Engine;
use super::control::names;
use crate::routes::readable;

pub(crate) struct Grants(pub(crate) Arc<Engine>);

impl CapabilityGrants for Grants {
    fn grant<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Option<Grant>> {
        Box::pin(async move {
            match grant(&self.0, worker_id).await {
                Ok(grant) => grant,
                Err(error) => {
                    // A run session whose grant cannot be read calls nothing.
                    tracing::warn!(worker_id, %error, "a run session's grant could not be read");
                    Some(Grant { actions: Vec::new(), max_class: ActionClass::Read })
                }
            }
        })
    }

    fn gate<'a>(&'a self, action: &'a RunAction) -> BoxFuture<'a, Result<RunActionDecision, eos_core::Error>> {
        Box::pin(super::gate::action(&self.0, action))
    }
}

async fn grant(engine: &Engine, worker_id: &str) -> Result<Option<Grant>, eos_core::Error> {
    let id = worker_id.to_owned();
    let found = engine
        .store
        .read(move |tx| {
            let Some(run) = tx.routine_sessions().run_of(&id)? else { return Ok(None) };
            let version = tx.routine_versions().find(&run.routine_id, &run.version_id)?;
            let blueprint = match version {
                Some(version) => readable(&version)?,
                None => None,
            };
            Ok(Some((run, blueprint)))
        })
        .await?;
    let Some((run, blueprint)) = found else { return Ok(None) };
    let Some(blueprint) = blueprint else {
        return Ok(Some(Grant { actions: Vec::new(), max_class: ActionClass::Read }));
    };
    let max_class = if run.role == RunRole::Checker { ActionClass::Read } else { ActionClass::Irreversible };
    let allowed = |class: ActionClass| max_class == ActionClass::Irreversible || class == ActionClass::Read;
    let mut actions = Vec::new();
    for capability in engine.reads.list().await? {
        if !blueprint.needs.iter().any(|need| names(need, &capability.id)) {
            continue;
        }
        for action in capability.manifest.actions.iter().filter(|action| allowed(action.class)) {
            actions.push(GrantedAction { capability: capability.id.clone(), action: action.name.clone() });
        }
    }
    Ok(Some(Grant { actions, max_class }))
}
