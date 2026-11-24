//! The `forge` routine's blueprint: the shape in `assets/forge.json`, each
//! agent that names a Forge definition filled from it (its brief, model,
//! effort and tools), so the definition files are the one place the
//! Forge's sessions are described.

use eos_contracts::WorkerDefinitionRecord;
use eos_core::Error;
use serde_json::{Value, json};

/// The built-in routine's slug.
pub const SLUG: &str = "forge";

const SHAPE: &str = include_str!("../assets/forge.json");

/// The blueprint, with `definitions` filled in. A definition the shape
/// names that is not given is an error: the Forge would start a session
/// with no brief.
pub fn blueprint(definitions: &[WorkerDefinitionRecord]) -> Result<Value, Error> {
    let mut blueprint: Value =
        serde_json::from_str(SHAPE).map_err(|e| Error::storage(format!("the Forge's blueprint: {e}")))?;
    let agents = blueprint["who"]["agents"].as_array_mut().into_iter().flatten();
    for agent in agents {
        let Some(name) = agent["definition"].as_str().map(str::to_owned) else { continue };
        let Some(definition) = definitions.iter().find(|definition| definition.name == name) else {
            return Err(Error::storage(format!("the Forge's definition {name} is missing")));
        };
        agent["brief"] = definition.body.trim().into();
        agent["model"] = definition.model.clone().unwrap_or_else(|| "sonnet".into()).into();
        agent["effort"] = definition.effort.map_or_else(|| json!("medium"), |effort| json!(effort));
        agent["tools"] = json!({"allow": definition.tools_allow.clone().unwrap_or_default()});
    }
    Ok(blueprint)
}
