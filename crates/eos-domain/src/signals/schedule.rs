//! When a clock schedule's slots fall, which one is due, and what a valid
//! schedule holds. A slot is a wall time on the schedule's zone, turned into
//! an instant by one rule ([`instant_of`]): a time the clocks skip runs as
//! long after the change as it was after the skipped hour began, a time they
//! pass twice runs at the first pass. Slots that turn into one instant are
//! one slot.

use eos_contracts::{DayPreset, Days, Issues, MonthDay, Repeat, Schedule};

use crate::time::{OffsetAt, civil_from_days, days_from_civil, instant_of, wall_clock};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;
/// Every shape has a slot at least once in 31 days.
const SEARCH_DAYS: i64 = 32;

/// `HH:MM` as minutes after midnight.
pub fn wall_minutes(text: &str) -> Option<i64> {
    let (hours, minutes) = text.split_once(':')?;
    let two_digits = |part: &str| {
        (part.len() == 2 && part.bytes().all(|b| b.is_ascii_digit())).then(|| part.parse::<i64>().ok()).flatten()
    };
    let (hours, minutes) = (two_digits(hours)?, two_digits(minutes)?);
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

/// Checks a schedule: its times, its step and window, its days and its zone.
/// `known` says whether this computer knows a zone's name.
pub fn validate(schedule: &Schedule, known: &dyn Fn(&str) -> bool, cx: &mut Issues) {
    let time = |cx: &mut Issues, text: &str| {
        if wall_minutes(text).is_none() {
            cx.push("Expected a time as HH:MM");
        }
    };
    let days_issues = |cx: &mut Issues, days: &Days| {
        if let Days::List(list) = days {
            cx.at("days", |cx| cx.arr_min(list.len(), 1));
        }
    };
    match &schedule.repeat {
        Repeat::Daily { at, days } => {
            cx.at("daily", |cx| time(cx, at));
            days_issues(cx, days);
        }
        Repeat::Every { minutes, between, days } => {
            cx.at("every", |cx| {
                cx.int_min(*minutes, 10, true);
                cx.int_max(*minutes, 24 * 60, true);
            });
            if let Some((start, end)) = between {
                cx.at("between", |cx| {
                    cx.idx(0, |cx| time(cx, start));
                    cx.idx(1, |cx| time(cx, end));
                    if wall_minutes(start).zip(wall_minutes(end)).is_some_and(|(start, end)| end <= start) {
                        cx.push("The window must end after it starts");
                    }
                });
            }
            days_issues(cx, days);
        }
        Repeat::Monthly { day, at } => {
            if let MonthDay::Day(n) = day {
                cx.at("monthly", |cx| {
                    cx.int_min(*n, 1, true);
                    cx.int_max(*n, 31, true);
                });
            }
            cx.at("at", |cx| time(cx, at));
        }
    }
    cx.at("zone", |cx| {
        if !known(&schedule.zone) {
            cx.push("Unknown time zone");
        }
    });
}

/// Monday is 0: day 0, 1970-01-01, was a Thursday.
fn weekday(day: i64) -> i64 {
    (day + 3).rem_euclid(7)
}

fn runs_on(days: &Days, day: i64) -> bool {
    match days {
        Days::Preset(DayPreset::All) => true,
        Days::Preset(DayPreset::Weekdays) => weekday(day) < 5,
        Days::List(list) => list.iter().any(|on| *on as i64 == weekday(day)),
    }
}

/// Whether `day` is the month's day `on`; a day the month lacks is its last.
fn is_month_day(on: MonthDay, day: i64) -> bool {
    let (year, month, of_month) = civil_from_days(day);
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let length = days_from_civil(next_year, next_month, 1) - days_from_civil(year, month, 1);
    let target = match on {
        MonthDay::Day(n) => n.min(length),
        MonthDay::Last(_) => length,
    };
    i64::from(of_month) == target
}

/// The wall times `repeat` names on one day of its zone's calendar, as
/// minutes after midnight.
fn walls(repeat: &Repeat, day: i64) -> Vec<i64> {
    match repeat {
        Repeat::Daily { at, days } if runs_on(days, day) => wall_minutes(at).into_iter().collect(),
        Repeat::Every { minutes, between, days } if *minutes > 0 && runs_on(days, day) => {
            let window = match between {
                Some((start, end)) => wall_minutes(start).zip(wall_minutes(end)),
                None => Some((0, 24 * 60 - 1)),
            };
            let Some((start, end)) = window else { return Vec::new() };
            std::iter::successors(Some(start), |at| Some(at + minutes)).take_while(|at| *at <= end).collect()
        }
        Repeat::Monthly { day: on, at } if is_month_day(*on, day) => wall_minutes(at).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// One calendar day's slots as instants, ascending, each instant once.
fn day_slots(repeat: &Repeat, day: i64, offset_at: OffsetAt<'_>) -> Vec<i64> {
    let mut slots: Vec<i64> =
        walls(repeat, day).into_iter().map(|at| instant_of(day * DAY_MS + at * MINUTE_MS, offset_at)).collect();
    slots.sort_unstable();
    slots.dedup();
    slots
}

/// The calendar day the zone's clock shows at `at`.
fn day_at(at: i64, offset_at: OffsetAt<'_>) -> i64 {
    wall_clock(at, offset_at).div_euclid(DAY_MS)
}

// A change of the clocks moves a slot by hours: it can land on the calendar
// day next to its own, never further. So a search starts one day out and ends
// at the first day that has what it looks for.

/// The latest slot at or before `now`.
pub fn latest_slot(repeat: &Repeat, now: i64, offset_at: OffsetAt<'_>) -> Option<i64> {
    let today = day_at(now, offset_at);
    (today - SEARCH_DAYS..=today + 1)
        .rev()
        .find_map(|day| day_slots(repeat, day, offset_at).into_iter().rfind(|slot| *slot <= now))
}

/// The first slot after `after`.
pub fn next_slot(repeat: &Repeat, after: i64, offset_at: OffsetAt<'_>) -> Option<i64> {
    let today = day_at(after, offset_at);
    (today - 1..=today + SEARCH_DAYS)
        .find_map(|day| day_slots(repeat, day, offset_at).into_iter().find(|slot| *slot > after))
}

/// How many slots fall strictly between `after` and `before`.
fn slots_between(repeat: &Repeat, after: i64, before: i64, offset_at: OffsetAt<'_>) -> i64 {
    (day_at(after, offset_at) - 1..=day_at(before, offset_at) + 1)
        .map(|day| day_slots(repeat, day, offset_at).into_iter().filter(|slot| after < *slot && *slot < before).count())
        .sum::<usize>() as i64
}

/// What the scheduler keeps of one schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduleState<'a> {
    pub repeat: &'a Repeat,
    /// When the schedule was made, changed or resumed: no slot before it fires.
    pub armed_at: i64,
    /// The last slot that fired.
    pub last_slot_at: Option<i64>,
}

/// A slot to fire now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Due {
    pub slot: i64,
    /// Slots since the last one fired (or since arming) that run as this one.
    pub missed: i64,
    pub late_by: i64,
}

/// The last slot fired more than a day ahead of `now`: the clock was wrong
/// when it fired. The scheduler writes `now` in its place.
pub fn clock_reset(state: &ScheduleState<'_>, now: i64) -> bool {
    state.last_slot_at.is_some_and(|last| last - now > DAY_MS)
}

/// The latest slot, when it has not fired: none before arming, none at or
/// before the last one fired (a clock set back fires nothing twice), and one
/// however many passed while the computer slept or the clock jumped ahead.
pub fn due(state: &ScheduleState<'_>, now: i64, offset_at: OffsetAt<'_>) -> Option<Due> {
    let last = if clock_reset(state, now) { Some(now) } else { state.last_slot_at };
    let slot = latest_slot(state.repeat, now, offset_at)?;
    if slot < state.armed_at || last.is_some_and(|last| slot <= last) {
        return None;
    }
    let after = last.unwrap_or(i64::MIN).max(state.armed_at - 1);
    Some(Due { slot, missed: slots_between(state.repeat, after, slot, offset_at), late_by: now - slot })
}

#[cfg(test)]
mod tests;
