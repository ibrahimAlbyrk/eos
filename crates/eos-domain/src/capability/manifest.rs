//! `capability.toml`: what a capability is, what it may reach, what it
//! needs and the actions it offers. A key this version does not know is
//! refused rather than ignored: a declaration Eos does not enforce must not
//! pass for one it does.

use eos_contracts::{ActionClass, Issue, ValidationError};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A call runs this long unless its action says otherwise.
pub const DEFAULT_TIMEOUT_S: u32 = 30;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub summary: String,
    pub form: Form,
    pub works: Works,
    /// A file of the package that `list_capabilities` returns.
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub requires: Requires,
    #[serde(default)]
    pub reach: Reach,
    #[serde(default)]
    pub health: Option<HealthCheck>,
    #[serde(default)]
    pub tests: Option<Tests>,
    /// The server an `mcp` capability's actions are tools of.
    #[serde(default)]
    pub server: Option<McpServer>,
    #[serde(default)]
    pub settings: Vec<Setting>,
    #[serde(default)]
    pub actions: Vec<Action>,
    #[serde(default)]
    pub channels: Vec<Channel>,
    #[serde(default)]
    pub secrets: Vec<Secret>,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub candidates: Vec<Candidates>,
    #[serde(default)]
    pub items: Vec<ItemDecl>,
}

impl Manifest {
    pub fn action(&self, name: &str) -> Option<&Action> {
        self.actions.iter().find(|action| action.name == name)
    }
}

/// How the capability's actions run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Form {
    /// Instructions only, no actions.
    Skill,
    /// A program per call.
    Script,
    /// One confined MCP server.
    Mcp,
    /// A dashboard plugin, maybe with actions of another form.
    Plugin,
    /// Eos's own Rust code.
    Builtin,
}

/// Where the capability works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Works {
    ThisMac,
    AnyMac,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Requires {
    #[serde(default)]
    pub programs: Vec<String>,
    /// `automation:<bundle id>` and the like.
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// What the capability's code may reach; everything else is denied.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reach {
    /// Domain names, or `*.` and a domain for its subdomains.
    #[serde(default)]
    pub hosts: Vec<String>,
    /// Bundle ids of the apps it sends Apple Events to.
    #[serde(default)]
    pub apple_events: Vec<String>,
    #[serde(default)]
    pub files_read: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthCheck {
    /// A read action.
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tests {
    /// The offline tests.
    pub command: Vec<String>,
    /// The action one live call is made to before the capability is
    /// proposed.
    #[serde(default)]
    pub live: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpServer {
    Local(LocalServer),
    Remote(RemoteServer),
}

/// A program Eos starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalServer {
    pub run: Vec<String>,
}

/// A remote server, reached with a static token in a header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteServer {
    pub url: String,
    /// The secret sent as the token.
    #[serde(default)]
    pub header_secret: Option<String>,
}

/// A value the user gives, kept outside the package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setting {
    pub name: String,
    pub label: String,
    pub kind: SettingKind,
    #[serde(default)]
    pub required: bool,
    /// What a `choice` offers.
    #[serde(default)]
    pub choices: Vec<String>,
}

impl Setting {
    /// The variable a package's code finds the setting's value in.
    pub fn env(&self) -> String {
        format!("EOS_SETTING_{}", self.name.to_ascii_uppercase())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingKind {
    Text,
    Phone,
    Email,
    Choice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    /// `snake_case`, unique in the capability.
    pub name: String,
    pub summary: String,
    pub class: ActionClass,
    #[serde(default)]
    pub recipient: Recipient,
    /// The action that takes this one back; empty when nothing can.
    #[serde(default)]
    pub undo: String,
    /// A `script` action's program: input JSON on stdin, output JSON on
    /// stdout.
    #[serde(default)]
    pub run: Vec<String>,
    /// An `mcp` action's tool, frozen with its summary at review.
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_s: u32,
    /// A JSON schema in the subset `schema` reads.
    #[serde(default)]
    pub input: Option<Value>,
    /// The same subset; `untrusted = true` marks text from outside.
    #[serde(default)]
    pub output: Option<Value>,
}

fn default_timeout() -> u32 {
    DEFAULT_TIMEOUT_S
}

/// Who an action reaches: `user`, `input:<json pointer>` (the input names
/// it) or `none`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum Recipient {
    User,
    Input(String),
    #[default]
    None,
}

impl TryFrom<String> for Recipient {
    type Error = String;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        match text.as_str() {
            "user" => Ok(Recipient::User),
            "none" => Ok(Recipient::None),
            _ => match text.strip_prefix("input:") {
                Some(pointer) if pointer.starts_with('/') => Ok(Recipient::Input(pointer.to_owned())),
                _ => Err(format!("recipient {text:?} is not user, input:/<pointer> or none")),
            },
        }
    }
}

impl From<Recipient> for String {
    fn from(recipient: Recipient) -> String {
        match recipient {
            Recipient::User => "user".to_owned(),
            Recipient::Input(pointer) => format!("input:{pointer}"),
            Recipient::None => "none".to_owned(),
        }
    }
}

/// An action results are delivered through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Channel {
    pub name: String,
    pub action: String,
}

/// A secret the user enters once; its value lives in Eos's own Keychain
/// items, never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Secret {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub help: Option<String>,
    /// The environment variable the code reads it from.
    #[serde(default)]
    pub env: Option<String>,
    /// The hosts it is sent to.
    #[serde(default)]
    pub hosts: Vec<String>,
}

/// Where signals come from: a read action that takes `{cursor}` and returns
/// `{items, cursor, pollAfterS}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub name: String,
    /// The kind of item it gives.
    pub item: String,
    pub action: String,
    /// The facts rules may test, by name.
    #[serde(default)]
    pub facts: IndexMap<String, FactType>,
    /// What can happen to an item (`opened`, `updated`).
    #[serde(default)]
    pub events: Vec<String>,
    /// The events that end their item (a pull request merged or closed).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub closing: Vec<String>,
    #[serde(default)]
    pub interval_s: Option<u32>,
    #[serde(default)]
    pub min_interval_s: Option<u32>,
    /// The service can also push its events.
    #[serde(default)]
    pub push: Option<Push>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactType {
    String,
    /// A list of strings.
    Strings,
    Bool,
    Number,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Push {
    pub verify: Verify,
    pub signature_header: String,
    pub delivery_header: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Verify {
    #[serde(rename = "hmac-sha256")]
    HmacSha256,
}

/// The read action that lists items of a kind for the user to pick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidates {
    pub item: String,
    pub action: String,
}

/// A kind of item and how to know one in what the user types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemDecl {
    pub kind: String,
    pub noun: String,
    /// JavaScript regular expressions over links and numbers.
    #[serde(default)]
    pub recognise: Vec<String>,
}

/// Reads `capability.toml`. Only its shape: [`check`](super::check::check)
/// holds it to the rules.
pub fn parse(text: &str) -> Result<Manifest, ValidationError> {
    toml::from_str(text).map_err(|e| ValidationError {
        issues: vec![Issue { path: Vec::new(), message: e.message().trim_end().to_owned() }],
    })
}
