//! A routine's blueprint: which formats this app reads, the rules a blueprint
//! meets before a version is kept and again when a run starts, and what a
//! version stores: its canonical JSON, whose bytes `eos_contracts::Blueprint`
//! spells out, and the hash of it.

use std::collections::HashSet;
use std::fmt;

use eos_contracts::{
    BLUEPRINT_FORMAT, Blueprint, Freedom, Issues, Num, OptionType, Recipient, RecipientKind, RoutineAgent, RoutineKind,
    RoutineLimits, RoutineOption, Trigger, ValidationError, Who, WhoDepth,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::signals::{when, which};
use crate::sync::stable::stringify;

/// At most this many options show in the run form itself.
pub const INLINE_OPTIONS_MAX: usize = 3;

/// One step of the upgrade chain: a blueprint of format n, the step's place
/// counted from 1, written as format n + 1.
type Upgrade = fn(Value) -> Value;

/// One step for each format before this app's: a new format cannot be added
/// without the step that brings the one before it up.
const UPGRADES: [Upgrade; BLUEPRINT_FORMAT as usize - 1] = [];

/// A stored or received blueprint, as this app can use it.
#[derive(Debug, Clone, PartialEq)]
pub enum Readable {
    /// Of a format this app knows, brought up to [`BLUEPRINT_FORMAT`].
    Current(Box<Blueprint>),
    /// Made by a newer Eos: shown as it is, never run or edited here.
    Newer { format: i64, blueprint: Value },
}

impl Readable {
    /// Whether this app may run the blueprint, and edit it.
    pub fn runnable(&self) -> bool {
        matches!(self, Readable::Current(_))
    }
}

/// Reads a blueprint of any format: a known one is upgraded and typed, a
/// newer one kept as it came. Fails when `format` is not a whole number of
/// at least 1, or when a known format lacks the blueprint's shape.
pub fn read(blueprint: &Value) -> Result<Readable, ValidationError> {
    let Some(format) = blueprint.get("format").and_then(Value::as_i64).filter(|format| *format >= 1) else {
        let issue = eos_contracts::Issue {
            path: vec!["format".to_owned()],
            message: "Expected a whole number of at least 1".to_owned(),
        };
        return Err(ValidationError { issues: vec![issue] });
    };
    if format > BLUEPRINT_FORMAT {
        return Ok(Readable::Newer { format, blueprint: blueprint.clone() });
    }
    eos_contracts::read(&upgrade(blueprint.clone(), format)).map(|blueprint| Readable::Current(Box::new(blueprint)))
}

/// Brings a blueprint of format `from` up to [`BLUEPRINT_FORMAT`], one format
/// at a time.
pub fn upgrade(blueprint: Value, from: i64) -> Value {
    let done = usize::try_from(from.saturating_sub(1)).unwrap_or_default();
    UPGRADES.iter().skip(done).fold(blueprint, |blueprint, step| step(blueprint))
}

/// The text a version stores.
pub fn canonical_json(blueprint: &Blueprint) -> String {
    stringify(&serde_json::to_value(blueprint).expect("a blueprint's keys are all strings"))
}

/// What `routine_versions.hash` holds: the lowercase hex SHA-256 of the
/// version's canonical JSON.
pub fn hash(canonical_json: &str) -> String {
    hex::encode(Sha256::digest(canonical_json.as_bytes()))
}

/// One finding of [`validate`]: where in the blueprint, and what is wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    /// Object keys and list indexes from the blueprint's root.
    pub path: Vec<String>,
    pub message: String,
    pub severity: Severity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
    /// Blocks keeping the version and starting a run.
    Error,
    /// Shown; the version may still be kept.
    Warning,
}

/// What the rules need from outside the blueprint.
pub struct Context<'a> {
    /// The routine's id (`rt-…`).
    pub routine: &'a str,
    /// Every other routine and the routines its head runs after.
    pub chains: &'a [(String, Vec<String>)],
    /// Whether this computer knows a time zone's name.
    pub known_zone: &'a dyn Fn(&str) -> bool,
}

impl fmt::Debug for Context<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Context").field("routine", &self.routine).field("chains", &self.chains).finish_non_exhaustive()
    }
}

/// Checks a blueprint. Every finding comes back, in the order of the fields.
pub fn validate(blueprint: &Blueprint, context: &Context<'_>) -> Vec<Issue> {
    let mut cx = Issues::default();
    if blueprint.format != BLUEPRINT_FORMAT {
        cx.push_at("format", format!("Expected format {BLUEPRINT_FORMAT}"));
    }
    cx.at("name", |cx| cx.str_min(blueprint.name.trim(), 1));
    cx.at("options", |cx| options(&blueprint.options, &blueprint.who.agents, cx));
    cx.at("when", |cx| {
        when::validate(&blueprint.when, context.known_zone, cx);
        cx.at("on", |cx| chain(blueprint, context, cx));
    });
    cx.at("which", |cx| which::validate(&blueprint.which, cx));
    cx.at("who", |cx| who(&blueprint.who, cx));
    cx.at("how", |cx| cx.at("checks", |cx| unique(cx, blueprint.how.checks.iter().map(|check| &check.key), "key")));
    cx.at("goesTo", |cx| goes_to(&blueprint.goes_to, cx));
    cx.at("freedom", |cx| freedom(&blueprint.freedom, cx));
    cx.at("limits", |cx| limits(&blueprint.limits, blueprint.kind, cx));
    project(blueprint, &mut cx);
    cx.into_vec()
        .into_iter()
        .map(|issue| Issue { path: issue.path, message: issue.message, severity: Severity::Error })
        .collect()
}

fn options(options: &[RoutineOption], agents: &[RoutineAgent], cx: &mut Issues) {
    if options.iter().filter(|option| option.inline).count() > INLINE_OPTIONS_MAX {
        cx.push(format!("At most {INLINE_OPTIONS_MAX} options show inline"));
    }
    unique(cx, options.iter().map(|option| &option.key), "key");
    for (i, option) in options.iter().enumerate() {
        cx.idx(i, |cx| {
            default_issues(option, cx);
            for (j, affect) in option.affects.iter().flatten().enumerate() {
                if !agents.iter().any(|agent| agent.key == affect.agent) {
                    cx.at("affects", |cx| cx.idx(j, |cx| cx.push_at("agent", "Names no agent of the routine")));
                }
            }
        });
    }
}

/// An option's default is a value of its type: for a choice, one of its values.
fn default_issues(option: &RoutineOption, cx: &mut Issues) {
    let default = &option.default;
    let (fits, expected) = match option.r#type {
        OptionType::Choice => {
            let values = option.values.as_deref().unwrap_or_default();
            if values.is_empty() {
                cx.push_at("values", "A choice needs values");
                return;
            }
            (default.as_str().is_some_and(|default| values.iter().any(|value| value == default)), "one of the values")
        }
        OptionType::Bool => (default.is_boolean(), "a boolean"),
        OptionType::Text => (default.is_string(), "a text"),
        OptionType::Number => (default.is_number(), "a number"),
    };
    if !fits {
        cx.push_at("default", format!("Expected {expected}"));
    }
}

/// An `after` trigger that closes a loop: through the other routines, this
/// one would run after itself.
fn chain(blueprint: &Blueprint, context: &Context<'_>, cx: &mut Issues) {
    let upstreams: Vec<String> = blueprint.when.on.iter().filter_map(after_routine).map(str::to_owned).collect();
    if upstreams.is_empty() {
        return;
    }
    let mut chains = vec![(context.routine.to_owned(), upstreams)];
    chains.extend(context.chains.iter().filter(|(routine, _)| routine != context.routine).cloned());
    let Err(cycle) = when::check_chains(&chains) else { return };
    let Some(at) = cycle.iter().position(|routine| routine == context.routine) else { return };
    let upstream = cycle[(at + 1) % cycle.len()].as_str();
    if let Some(i) = blueprint.when.on.iter().position(|trigger| after_routine(trigger) == Some(upstream)) {
        cx.idx(i, |cx| cx.at("after", |cx| cx.push_at("routine", "Makes a loop: this routine would run after itself")));
    }
}

fn after_routine(trigger: &Trigger) -> Option<&str> {
    match trigger {
        Trigger::After { after, .. } => Some(&after.routine),
        _ => None,
    }
}

fn who(who: &Who, cx: &mut Issues) {
    let agents = &who.agents;
    match who.depth {
        WhoDepth::Solo if agents.len() != 1 => cx.push_at("agents", "A solo routine has exactly one agent"),
        WhoDepth::Team if agents.iter().filter(|agent| agent.lead).count() != 1 => {
            cx.push_at("agents", "A team has exactly one lead");
        }
        WhoDepth::Script => {
            if who.script.is_none() {
                cx.push_at("script", "A script routine needs its script");
            }
            if !agents.is_empty() {
                cx.push_at("agents", "A script routine has no agents");
            }
        }
        WhoDepth::Solo | WhoDepth::Team => {}
    }
    cx.at("agents", |cx| {
        // Outside text in a lead's context could steer every agent it starts.
        if who.depth == WhoDepth::Team && agents.len() > 1 {
            for (i, agent) in agents.iter().enumerate() {
                if agent.lead && agent.reads_outside {
                    cx.idx(i, |cx| cx.push_at("lead", "An agent that reads outside text cannot lead a team"));
                }
            }
        }
        unique(cx, agents.iter().map(|agent| &agent.key), "key");
    });
}

fn goes_to(recipients: &[Recipient], cx: &mut Issues) {
    unique(cx, recipients.iter().map(|recipient| &recipient.id), "id");
    for (i, recipient) in recipients.iter().enumerate() {
        if let RecipientKind::ItemPlace { bound: Some(bound), .. } = &recipient.kind {
            cx.idx(i, |cx| cx.at("bound", |cx| which::validate_rule(bound, cx)));
        }
    }
}

/// A grant's rule meets the same bounds as Which's.
fn freedom(freedom: &Freedom, cx: &mut Issues) {
    cx.at("grants", |cx| {
        for (i, grant) in freedom.grants.iter().enumerate() {
            cx.idx(i, |cx| cx.at("when", |cx| which::validate_rule(&grant.when, cx)));
        }
    });
}

fn limits(limits: &RoutineLimits, kind: RoutineKind, cx: &mut Issues) {
    // A project is one long run: only its day budget bounds it.
    if kind != RoutineKind::Project {
        cx.at("perRunUsd", |cx| within_usd(cx, limits.per_run_usd, 0.05, 100.0));
        cx.at("perRunMinutes", |cx| within(cx, limits.per_run_minutes, 1, 240));
    }
    cx.at("perDayUsd", |cx| within_usd(cx, limits.per_day_usd, 0.5, 500.0));
    cx.at("parallel", |cx| within(cx, limits.parallel, 1, 3));
}

fn within_usd(cx: &mut Issues, value: Num, min: f64, max: f64) {
    cx.num_min(value, min, true);
    cx.num_max(value, max, true);
}

fn within(cx: &mut Issues, value: i64, min: i64, max: i64) {
    cx.int_min(value, min, true);
    cx.int_max(value, max, true);
}

/// A project routine has its project slot, and that slot has milestones.
fn project(blueprint: &Blueprint, cx: &mut Issues) {
    match &blueprint.project {
        None if blueprint.kind == RoutineKind::Project => cx.push_at("project", "A project routine needs its project"),
        None => {}
        Some(project) => cx.at("project", |cx| {
            cx.at("milestones", |cx| {
                cx.arr_min(project.milestones.len(), 1);
                unique(cx, project.milestones.iter().map(|milestone| &milestone.key), "key");
            });
        }),
    }
}

/// Flags each entry whose `field` an earlier entry already holds.
fn unique<'a>(cx: &mut Issues, keys: impl Iterator<Item = &'a String>, field: &str) {
    let mut seen = HashSet::new();
    for (i, key) in keys.enumerate() {
        if !seen.insert(key) {
            cx.idx(i, |cx| cx.push_at(field, "An earlier entry has the same one"));
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
