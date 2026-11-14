//! Wire types of the commands routes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CommandsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl Validate for CommandsQuery {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandItem {
    pub name: String,
    pub description: String,
    pub source: CommandItemSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
}

impl Validate for CommandItem {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CommandItemSource {
    User,
    Project,
    Skill,
    Plugin,
    Claude,
}

impl Validate for CommandItemSource {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CommandsResponse {
    pub commands: Vec<CommandItem>,
}

impl Validate for CommandsResponse {}
