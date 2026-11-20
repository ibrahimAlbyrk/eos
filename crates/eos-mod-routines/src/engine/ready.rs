//! What a start's runs need that is knowable before any is queued: the
//! capabilities the version needs taking calls, and, when an agent works in
//! a repository, a project here that is its clone. A start that lacks one
//! is refused with what is missing, so no run is spent finding out.

use eos_contracts::{AgentWorkspace, Blueprint, RunInput};
use eos_core::capability::MissingNeed;
use eos_core::routine::{StartError, Unready};
use eos_domain::capability::health::HealthState;
use serde_json::Value;

use super::Engine;
use super::workspace::{self, Missing};

/// A need's capability id: the need itself, or its `id`.
fn need_id(need: &Value) -> Option<String> {
    match need {
        Value::String(id) => Some(id.clone()),
        Value::Object(fields) => fields.get("id").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

fn unready(need: MissingNeed) -> Unready {
    match need.health {
        Some(health) if health.state == HealthState::NeedsSignIn => Unready::SignIn { capability: need.id },
        _ => Unready::Capability { capability: need.id },
    }
}

/// Refuses the start when its runs would fail for something not set up here.
pub(crate) async fn check(engine: &Engine, blueprint: &Blueprint, inputs: &[RunInput]) -> Result<(), StartError> {
    let needs: Vec<String> = blueprint.needs.iter().filter_map(need_id).collect();
    if let Some(need) = engine.reads.missing(&needs).await?.into_iter().next() {
        return Err(StartError::Unready(unready(need)));
    }
    if blueprint.who.agents.iter().all(|agent| agent.workspace == AgentWorkspace::None) {
        return Ok(());
    }
    for input in inputs {
        match workspace::find(engine, blueprint, input).await {
            Ok(_) | Err(Missing::Unknown) => {}
            Err(Missing::NoClone(repo)) => return Err(StartError::Unready(Unready::NoLocalClone { repo })),
            Err(Missing::NotReady(capability)) => {
                let need = engine.reads.missing(std::slice::from_ref(&capability)).await?.into_iter().next();
                let need = need.unwrap_or(MissingNeed { id: capability, health: None });
                return Err(StartError::Unready(unready(need)));
            }
        }
    }
    Ok(())
}
