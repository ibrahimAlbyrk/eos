//! The When slot's rules: what a valid one holds, the chains its `after`
//! triggers make between routines, and the slot in plain English.

use std::collections::{HashMap, HashSet};

use eos_contracts::{Issues, Trigger, When};

use super::schedule;

mod describe;

pub use describe::describe;

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
/// the first. It starts at the first entry that is on a loop, so a caller
/// that lists its own routine first learns of the loop through it even when
/// others already loop among themselves.
pub fn check_chains(chains: &[(String, Vec<String>)]) -> Result<(), Vec<String>> {
    let upstreams: HashMap<&str, &[String]> =
        chains.iter().map(|(routine, upstreams)| (routine.as_str(), upstreams.as_slice())).collect();
    for (routine, _) in chains {
        let mut path = vec![routine.as_str()];
        if back_to(routine, routine, &upstreams, &mut path, &mut HashSet::new()) {
            return Err(path.into_iter().map(str::to_owned).collect());
        }
    }
    Ok(())
}

/// Follows `routine`'s upstreams depth first, looking for `start`. `path`
/// holds the routines being followed, and the loop when one is found;
/// `seen` the routines already followed, which lead back no other way.
fn back_to<'a>(
    start: &str,
    routine: &str,
    upstreams: &HashMap<&'a str, &'a [String]>,
    path: &mut Vec<&'a str>,
    seen: &mut HashSet<&'a str>,
) -> bool {
    for upstream in upstreams.get(routine).copied().unwrap_or_default() {
        if upstream == start {
            return true;
        }
        if seen.insert(upstream) {
            path.push(upstream);
            if back_to(start, upstream, upstreams, path, seen) {
                return true;
            }
            path.pop();
        }
    }
    false
}

#[cfg(test)]
mod tests;
