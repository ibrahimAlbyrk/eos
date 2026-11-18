//! The When slot's rules: what a valid one holds, and the chains its `after`
//! triggers make between routines.

use std::collections::{HashMap, HashSet};

use eos_contracts::{Issues, Trigger, When};

use super::schedule;

/// Checks a When slot: each trigger, the limits and the batch. `known` says
/// whether this computer knows a zone's name.
pub fn validate(when: &When, known: &dyn Fn(&str) -> bool, cx: &mut Issues) {
    cx.at("on", |cx| {
        for (i, trigger) in when.on.iter().enumerate() {
            cx.idx(i, |cx| trigger_issues(trigger, known, cx));
        }
    });
    cx.at("limits", |cx| {
        cx.at("perHour", |cx| within(cx, when.limits.per_hour, 1, 200));
        cx.at("queued", |cx| within(cx, when.limits.queued, 1, 100));
    });
    if let Some(batch) = &when.batch {
        cx.at("batch", |cx| {
            cx.at("max", |cx| within(cx, batch.max, 2, 200));
            cx.at("waitMinutes", |cx| within(cx, batch.wait_minutes, 1, 24 * 60));
        });
    }
}

fn within(cx: &mut Issues, value: i64, min: i64, max: i64) {
    cx.int_min(value, min, true);
    cx.int_max(value, max, true);
}

fn trigger_issues(trigger: &Trigger, known: &dyn Fn(&str) -> bool, cx: &mut Issues) {
    match trigger {
        Trigger::Schedule { schedule, .. } => cx.at("schedule", |cx| schedule::validate(schedule, known, cx)),
        Trigger::Source { source, events, .. } => {
            cx.at("source", |cx| cx.str_min(source, 1));
            cx.at("events", |cx| {
                cx.arr_min(events.len(), 1);
                for (i, event) in events.iter().enumerate() {
                    cx.idx(i, |cx| cx.str_min(event, 1));
                }
            });
        }
        Trigger::Folder { folder, .. } => cx.at("folder", |cx| {
            cx.at("path", |cx| cx.str_min(&folder.path, 1));
            if let Some(names) = &folder.names {
                cx.at("names", |cx| cx.str_min(names, 1));
            }
            cx.at("events", |cx| cx.arr_min(folder.events.len(), 1));
        }),
        Trigger::Git { git, .. } => cx.at("git", |cx| {
            cx.at("repo", |cx| cx.str_min(&git.repo, 1));
            cx.at("branch", |cx| cx.str_min(&git.branch, 1));
        }),
        Trigger::After { after, .. } => {
            cx.at("after", |cx| cx.at("routine", |cx| cx.starts_with(&after.routine, "rt-")))
        }
    }
}

/// Finds a loop among routines that run after one another: each entry is a
/// routine and the routines its `after` triggers name. The loop comes back
/// as the routines along it, each running after the next and the last after
/// the first.
pub fn check_chains(chains: &[(String, Vec<String>)]) -> Result<(), Vec<String>> {
    let upstreams: HashMap<&str, &[String]> =
        chains.iter().map(|(routine, upstreams)| (routine.as_str(), upstreams.as_slice())).collect();
    let mut cleared = HashSet::new();
    for (routine, _) in chains {
        if let Some(cycle) = walk(routine, &upstreams, &mut Vec::new(), &mut cleared) {
            return Err(cycle);
        }
    }
    Ok(())
}

/// Follows `routine`'s upstreams depth first. `path` holds the routines
/// being followed; `cleared` the ones known to lead to no loop.
fn walk<'a>(
    routine: &'a str,
    upstreams: &HashMap<&'a str, &'a [String]>,
    path: &mut Vec<&'a str>,
    cleared: &mut HashSet<&'a str>,
) -> Option<Vec<String>> {
    if let Some(at) = path.iter().position(|seen| *seen == routine) {
        return Some(path[at..].iter().map(|seen| (*seen).to_owned()).collect());
    }
    if cleared.contains(routine) {
        return None;
    }
    path.push(routine);
    for upstream in upstreams.get(routine).copied().unwrap_or_default() {
        if let Some(cycle) = walk(upstream, upstreams, path, cleared) {
            return Some(cycle);
        }
    }
    path.pop();
    cleared.insert(routine);
    None
}

#[cfg(test)]
mod tests;
