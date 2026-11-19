//! The static check of a manifest, the first of the proofs a capability
//! from the Forge or from elsewhere passes before it runs: its names, the
//! hosts it reaches, its schemas, that every secret it asks for is handed to
//! its code, that every channel, source and check names an action of a
//! fitting class, and the limits. A manifest of Eos's own code passes the
//! same check with what only Eos may do.

use eos_contracts::{ActionClass, Issue, Issues};

use super::manifest::{Form, Manifest, McpServer};
use super::{reach, schema};
use crate::text::js_re;

/// Names only Eos's built-in capabilities, or a route, may have.
pub const RESERVED_IDS: [&str; 6] = ["github", "mail", "notify", "browser", "eos", "candidates"];

/// The most actions one capability offers.
pub const ACTIONS_MAX: usize = 32;

/// The most secrets one capability asks for.
pub const SECRETS_MAX: usize = 8;

/// The largest input schema, as JSON.
pub const INPUT_SCHEMA_MAX_BYTES: usize = 16 * 1024;

/// The longest a call may run.
pub const TIMEOUT_MAX_S: u32 = 300;

/// Every finding for a package's manifest, in the order of its fields; none
/// for a manifest that passes. A package is never `builtin`: what it says of
/// itself does not make it Eos's own code.
pub fn check(manifest: &Manifest) -> Vec<Issue> {
    findings(manifest, false)
}

/// [`check`] for the manifest a `BuiltinCapability` returns: it may take a
/// reserved id, and its code reads its secrets by name.
pub fn check_builtin(manifest: &Manifest) -> Vec<Issue> {
    findings(manifest, true)
}

fn findings(manifest: &Manifest, builtin: bool) -> Vec<Issue> {
    let mut cx = Issues::default();
    cx.at("id", |cx| id(manifest, builtin, cx));
    cx.at("name", |cx| cx.str_min(manifest.name.trim(), 1));
    cx.at("version", |cx| cx.str_min(manifest.version.trim(), 1));
    cx.at("summary", |cx| cx.str_min(manifest.summary.trim(), 1));
    if manifest.form == Form::Builtin && !builtin {
        cx.push_at("form", "Only Eos's own capabilities are builtin");
    }
    cx.at("reach", |cx| cx.at("hosts", |cx| hosts(&manifest.reach.hosts, cx)));
    if let Some(health) = &manifest.health {
        cx.at("health", |cx| names_action(manifest, &health.action, "action", &[ActionClass::Read], cx));
    }
    if let Some(live) = manifest.tests.as_ref().and_then(|tests| tests.live.as_deref()) {
        let fitting = [ActionClass::Read, ActionClass::WriteLocal, ActionClass::TellUser];
        cx.at("tests", |cx| names_action(manifest, live, "live", &fitting, cx));
    }
    cx.at("actions", |cx| actions(manifest, cx));
    cx.at("channels", |cx| {
        let fitting = [ActionClass::TellUser, ActionClass::Speak, ActionClass::Irreversible];
        for (i, channel) in manifest.channels.iter().enumerate() {
            cx.idx(i, |cx| names_action(manifest, &channel.action, "action", &fitting, cx));
        }
    });
    cx.at("secrets", |cx| secrets(manifest, builtin, cx));
    cx.at("sources", |cx| {
        for (i, source) in manifest.sources.iter().enumerate() {
            cx.idx(i, |cx| names_action(manifest, &source.action, "action", &[ActionClass::Read], cx));
        }
    });
    cx.at("candidates", |cx| {
        for (i, candidates) in manifest.candidates.iter().enumerate() {
            cx.idx(i, |cx| names_action(manifest, &candidates.action, "action", &[ActionClass::Read], cx));
        }
    });
    cx.into_vec()
}

fn id(manifest: &Manifest, builtin: bool, cx: &mut Issues) {
    if js_re!(r"^[a-z][a-z0-9-]{1,31}$").find(&manifest.id).is_none() {
        cx.push("An id is 2 to 32 lowercase letters, digits and hyphens, starting with a letter");
    } else if !builtin && RESERVED_IDS.contains(&manifest.id.as_str()) {
        cx.push(format!("{} is reserved", manifest.id));
    }
}

fn hosts(hosts: &[String], cx: &mut Issues) {
    for (i, host) in hosts.iter().enumerate() {
        if let Some(problem) = reach::host_problem(host) {
            cx.idx(i, |cx| cx.push(problem));
        }
    }
}

fn actions(manifest: &Manifest, cx: &mut Issues) {
    if manifest.actions.len() > ACTIONS_MAX {
        cx.push(format!("At most {ACTIONS_MAX} actions"));
    }
    for (i, action) in manifest.actions.iter().enumerate() {
        cx.idx(i, |cx| {
            if js_re!(r"^[a-z][a-z0-9_]*$").find(&action.name).is_none() {
                cx.push_at("name", "An action's name is snake_case");
            } else if manifest.actions[..i].iter().any(|earlier| earlier.name == action.name) {
                cx.push_at("name", format!("Another action is named {}", action.name));
            }
            cx.at("summary", |cx| cx.str_min(action.summary.trim(), 1));
            if !action.undo.is_empty() && manifest.action(&action.undo).is_none() {
                cx.push_at("undo", format!("Names no action: {}", action.undo));
            }
            if !(1..=TIMEOUT_MAX_S).contains(&action.timeout_s) {
                cx.push_at("timeout_s", format!("Expected 1 to {TIMEOUT_MAX_S} seconds"));
            }
            if let Some(input) = &action.input {
                cx.at("input", |cx| {
                    if serde_json::to_string(input).map_or(0, |json| json.len()) > INPUT_SCHEMA_MAX_BYTES {
                        cx.push(format!("An input schema is at most {} KiB", INPUT_SCHEMA_MAX_BYTES / 1024));
                    }
                    schema::report(input, cx);
                });
            }
            if let Some(output) = &action.output {
                cx.at("output", |cx| schema::report(output, cx));
            }
        });
    }
}

/// A secret is handed to the capability's code: through its environment
/// variable, or as the remote server's token. Built-in code reads its
/// secrets by name.
fn secrets(manifest: &Manifest, builtin: bool, cx: &mut Issues) {
    if manifest.secrets.len() > SECRETS_MAX {
        cx.push(format!("At most {SECRETS_MAX} secrets"));
    }
    let header_secret = match &manifest.server {
        Some(McpServer::Remote(server)) => server.header_secret.as_deref(),
        _ => None,
    };
    for (i, secret) in manifest.secrets.iter().enumerate() {
        cx.idx(i, |cx| {
            let used = secret.env.is_some() || header_secret == Some(secret.name.as_str());
            if !builtin && !used {
                cx.push(format!(
                    "{} is never handed to the code: give it an env, or name it as the server's header_secret",
                    secret.name
                ));
            }
            cx.at("hosts", |cx| hosts(&secret.hosts, cx));
        });
    }
}

/// `name` is an action of the manifest, of one of the `fitting` classes.
fn names_action(manifest: &Manifest, name: &str, key: &str, fitting: &[ActionClass], cx: &mut Issues) {
    match manifest.action(name) {
        None => cx.push_at(key, format!("Names no action: {name}")),
        Some(action) if !fitting.contains(&action.class) => {
            let words: Vec<String> = fitting.iter().map(|class| class_word(*class)).collect();
            cx.push_at(key, format!("{name} is {}; expected {}", class_word(action.class), words.join(" or ")));
        }
        Some(_) => {}
    }
}

/// The word the manifest writes a class as.
fn class_word(class: ActionClass) -> String {
    serde_json::to_value(class).ok().and_then(|word| word.as_str().map(str::to_owned)).unwrap_or_default()
}
