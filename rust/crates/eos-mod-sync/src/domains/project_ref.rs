//! A project as it travels between computers: its git-remote key, and its
//! path on the sender (a hint when the key matches no project here).

use eos_core::Error;
use eos_core::git::ProjectKeys;
use serde_json::{Value, json};

use super::refused;

/// `{key, path}` for this computer's `path`.
pub(super) async fn to_ref(keys: &dyn ProjectKeys, path: &str) -> Value {
    json!({ "key": keys.to_key(path).await, "path": path })
}

/// This computer's folder for a `{key, path}` another computer sent.
pub(super) async fn to_path(keys: &dyn ProjectKeys, project: &Value) -> Result<String, Error> {
    let text = |name: &str| project.get(name).and_then(Value::as_str).filter(|v| !v.is_empty());
    let (Some(key), Some(path)) = (text("key"), text("path")) else {
        return Err(refused("a project needs its key and its path"));
    };
    Ok(keys.to_path(key, path).await)
}
