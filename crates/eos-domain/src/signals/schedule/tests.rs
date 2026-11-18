use serde_json::{Value, json};

use super::*;
use crate::time::ms_from_iso;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

/// Each zone's offset in minutes east of UTC at the start of 2026, and its
/// changes to the end of 2030, as the zone files give them
/// (`zdump -v -c 2026,2031 <zone>`).
type ZoneTable = (&'static str, i32, &'static [(&'static str, i32)]);
const ZONES: [ZoneTable; 6] = [
    ("Europe/Istanbul", 180, &[]),
    (
        "America/New_York",
        -300,
        &[
            ("2026-03-08T07:00Z", -240),
            ("2026-11-01T06:00Z", -300),
            ("2027-03-14T07:00Z", -240),
            ("2027-11-07T06:00Z", -300),
            ("2028-03-12T07:00Z", -240),
            ("2028-11-05T06:00Z", -300),
            ("2029-03-11T07:00Z", -240),
            ("2029-11-04T06:00Z", -300),
            ("2030-03-10T07:00Z", -240),
            ("2030-11-03T06:00Z", -300),
        ],
    ),
    (
        "Europe/London",
        0,
        &[
            ("2026-03-29T01:00Z", 60),
            ("2026-10-25T01:00Z", 0),
            ("2027-03-28T01:00Z", 60),
            ("2027-10-31T01:00Z", 0),
            ("2028-03-26T01:00Z", 60),
            ("2028-10-29T01:00Z", 0),
            ("2029-03-25T01:00Z", 60),
            ("2029-10-28T01:00Z", 0),
            ("2030-03-31T01:00Z", 60),
            ("2030-10-27T01:00Z", 0),
        ],
    ),
    (
        // Summer time is half an hour: 02:00 becomes 02:30, and 02:00 becomes 01:30.
        "Australia/Lord_Howe",
        660,
        &[
            ("2026-04-04T15:00Z", 630),
            ("2026-10-03T15:30Z", 660),
            ("2027-04-03T15:00Z", 630),
            ("2027-10-02T15:30Z", 660),
            ("2028-04-01T15:00Z", 630),
            ("2028-09-30T15:30Z", 660),
            ("2029-03-31T15:00Z", 630),
            ("2029-10-06T15:30Z", 660),
            ("2030-04-06T15:00Z", 630),
            ("2030-10-05T15:30Z", 660),
        ],
    ),
    ("Asia/Kolkata", 330, &[]),
    ("UTC", 0, &[]),
];

fn utc(iso: &str) -> i64 {
    ms_from_iso(iso).expect("a time")
}

fn zone(name: &str) -> impl Fn(i64) -> i32 {
    let (_, base, changes) = ZONES.iter().find(|zone| zone.0 == name).copied().expect("a zone of the table");
    let changes: Vec<(i64, i32)> = changes.iter().map(|(at, offset)| (utc(at), *offset)).collect();
    move |at| changes.iter().rev().find(|(from, _)| *from <= at).map_or(base, |(_, offset)| *offset)
}

fn repeat(value: Value) -> Repeat {
    serde_json::from_value(value).expect("a repeat")
}

/// Every slot in `[from, until)`.
fn slots(repeat: &Repeat, from: i64, until: i64, offset_at: OffsetAt<'_>) -> Vec<i64> {
    std::iter::successors(next_slot(repeat, from - 1, offset_at), |slot| next_slot(repeat, *slot, offset_at))
        .take_while(|slot| *slot < until)
        .collect()
}

#[test]
fn a_time_reads_as_hh_mm_only() {
    assert_eq!(wall_minutes("05:00"), Some(300));
    assert_eq!(wall_minutes("23:59"), Some(1439));
    assert_eq!(wall_minutes("00:00"), Some(0));
    for bad in ["24:00", "05:60", "5:00", "05:0", "+5:00", "05:00:00", "0500", ""] {
        assert_eq!(wall_minutes(bad), None, "{bad}");
    }
}

#[test]
fn a_daily_slot_has_the_instants_dreams_has() {
    let ny = zone("America/New_York");
    let ny: OffsetAt<'_> = &ny;
    let daily = |at: &str| repeat(json!({"daily": at, "days": "all"}));
    // 01:30 that morning was still winter time, although "now" is summer time.
    assert_eq!(
        latest_slot(&daily("01:30"), utc("2026-03-08T08:00:00.000Z"), ny),
        Some(utc("2026-03-08T06:30:00.000Z"))
    );
    // From the night before, the next 03:00 is 23 hours later.
    let evening = utc("2026-03-07T12:00:00.000Z");
    assert_eq!(latest_slot(&daily("03:00"), evening, ny), Some(utc("2026-03-07T08:00:00.000Z")));
    assert_eq!(next_slot(&daily("03:00"), evening, ny), Some(utc("2026-03-08T07:00:00.000Z")));
    // 02:30 never happens that night: it is 03:30 summer time.
    assert_eq!(
        latest_slot(&daily("02:30"), utc("2026-03-08T12:00:00.000Z"), ny),
        Some(utc("2026-03-08T07:30:00.000Z"))
    );
    // 00:30 that night was still summer time, although "now" is winter time.
    assert_eq!(
        latest_slot(&daily("00:30"), utc("2026-11-01T17:00:00.000Z"), ny),
        Some(utc("2026-11-01T04:30:00.000Z"))
    );
    // From the night before, the next 03:00 is 25 hours later.
    assert_eq!(next_slot(&daily("03:00"), utc("2026-10-31T12:00:00.000Z"), ny), Some(utc("2026-11-01T08:00:00.000Z")));
    // 01:30 happens twice that night: the first.
    assert_eq!(
        latest_slot(&daily("01:30"), utc("2026-11-01T17:00:00.000Z"), ny),
        Some(utc("2026-11-01T05:30:00.000Z"))
    );

    // 2026-03-10, midnight UTC.
    let midnight = 1_773_100_800_000;
    let three = daily("03:00");
    assert_eq!(latest_slot(&three, midnight + 4 * HOUR, &|_| 0), Some(midnight + 3 * HOUR));
    assert_eq!(latest_slot(&three, midnight + 2 * HOUR, &|_| 0), Some(midnight - 21 * HOUR));
    assert_eq!(next_slot(&three, midnight + 4 * HOUR, &|_| 0), Some(midnight + 27 * HOUR));
    // Three hours east of UTC, 03:00 is midnight UTC.
    assert_eq!(latest_slot(&three, midnight + HOUR, &|_| 180), Some(midnight));
}

#[test]
fn a_daily_slot_runs_on_its_days_only() {
    let utc0: OffsetAt<'_> = &|_| 0;
    // Saturday noon: the last weekday slot was Friday's; the next is Monday's.
    let weekdays = repeat(json!({"daily": "05:00", "days": "weekdays"}));
    assert_eq!(latest_slot(&weekdays, utc("2026-03-14T12:00Z"), utc0), Some(utc("2026-03-13T05:00Z")));
    assert_eq!(next_slot(&weekdays, utc("2026-03-13T06:00Z"), utc0), Some(utc("2026-03-16T05:00Z")));
    let sundays = repeat(json!({"daily": "05:00", "days": ["sun"]}));
    assert_eq!(next_slot(&sundays, utc("2026-03-10T00:00Z"), utc0), Some(utc("2026-03-15T05:00Z")));
    assert_eq!(latest_slot(&sundays, utc("2026-03-10T00:00Z"), utc0), Some(utc("2026-03-08T05:00Z")));
    let none = repeat(json!({"daily": "05:00", "days": []}));
    assert_eq!((latest_slot(&none, 0, utc0), next_slot(&none, 0, utc0)), (None, None));
}

#[test]
fn every_n_minutes_counts_from_midnight_or_from_the_start_of_its_window() {
    let utc0: OffsetAt<'_> = &|_| 0;
    // 25 minutes do not divide a day: the last slot is 23:45, then midnight again.
    let every = repeat(json!({"every": 25, "days": "all"}));
    assert_eq!(latest_slot(&every, utc("2026-03-10T00:10Z"), utc0), Some(utc("2026-03-10T00:00Z")));
    assert_eq!(latest_slot(&every, utc("2026-03-10T23:59Z"), utc0), Some(utc("2026-03-10T23:45Z")));
    assert_eq!(next_slot(&every, utc("2026-03-10T23:45Z"), utc0), Some(utc("2026-03-11T00:00Z")));

    let window = repeat(json!({"every": 30, "between": ["09:15", "17:00"], "days": "weekdays"}));
    assert_eq!(next_slot(&window, utc("2026-03-10T08:00Z"), utc0), Some(utc("2026-03-10T09:15Z")));
    assert_eq!(latest_slot(&window, utc("2026-03-10T17:20Z"), utc0), Some(utc("2026-03-10T16:45Z")));
    assert_eq!(next_slot(&window, utc("2026-03-10T16:45Z"), utc0), Some(utc("2026-03-11T09:15Z")));
    assert_eq!(next_slot(&window, utc("2026-03-13T17:00Z"), utc0), Some(utc("2026-03-16T09:15Z")));
    // The end of the window is a slot when the steps reach it.
    let hourly = repeat(json!({"every": 60, "between": ["09:00", "17:00"], "days": "all"}));
    assert_eq!(slots(&hourly, utc("2026-03-10T00:00Z"), utc("2026-03-11T00:00Z"), utc0).len(), 9);
    let daily = repeat(json!({"every": 1440, "days": "all"}));
    assert_eq!(next_slot(&daily, utc("2026-03-10T00:00Z"), utc0), Some(utc("2026-03-11T00:00Z")));
}

#[test]
fn monthly_runs_on_the_last_day_a_month_has() {
    let utc0: OffsetAt<'_> = &|_| 0;
    let on_31 = repeat(json!({"monthly": 31, "at": "08:00"}));
    assert_eq!(next_slot(&on_31, utc("2026-04-01T00:00Z"), utc0), Some(utc("2026-04-30T08:00Z")));
    assert_eq!(next_slot(&on_31, utc("2026-02-01T00:00Z"), utc0), Some(utc("2026-02-28T08:00Z")));
    assert_eq!(next_slot(&on_31, utc("2028-02-01T00:00Z"), utc0), Some(utc("2028-02-29T08:00Z")));
    assert_eq!(next_slot(&on_31, utc("2026-04-30T08:00Z"), utc0), Some(utc("2026-05-31T08:00Z")));
    assert_eq!(latest_slot(&on_31, utc("2026-03-15T00:00Z"), utc0), Some(utc("2026-02-28T08:00Z")));
    let last = repeat(json!({"monthly": "last", "at": "18:00"}));
    assert_eq!(next_slot(&last, utc("2026-01-31T19:00Z"), utc0), Some(utc("2026-02-28T18:00Z")));
    assert_eq!(latest_slot(&last, utc("2026-12-31T17:00Z"), utc0), Some(utc("2026-11-30T18:00Z")));
    let first = repeat(json!({"monthly": 1, "at": "00:00"}));
    assert_eq!(next_slot(&first, utc("2026-12-01T00:00Z"), utc0), Some(utc("2027-01-01T00:00Z")));
}

#[test]
fn a_skipped_time_runs_late_and_a_doubled_one_once_in_every_zone_from_2026_to_2030() {
    // (zone, slots moved by a skip, slots at the first of two passes) over the times below.
    let expected = [
        ("Europe/Istanbul", 0, 0),
        ("America/New_York", 10, 10),
        ("Europe/London", 10, 10),
        ("Australia/Lord_Howe", 5, 10),
        ("Asia/Kolkata", 0, 0),
        ("UTC", 0, 0),
    ];
    let (first_day, end_day) = (days_from_civil(2026, 1, 1), days_from_civil(2031, 1, 1));
    for (name, skipped, doubled) in expected {
        let offset_at = zone(name);
        let offset_at: OffsetAt<'_> = &offset_at;
        let (mut moved, mut first_pass) = (0, 0);
        for at in ["00:30", "01:30", "01:45", "02:15", "02:30", "05:00"] {
            let daily = repeat(json!({"daily": at, "days": "all"}));
            let (mut day, mut previous) = (first_day, None);
            let mut after = instant_of(first_day * DAY, offset_at) - 1;
            while let Some(slot) = next_slot(&daily, after, offset_at) {
                let wall = wall_clock(slot, offset_at);
                if wall.div_euclid(DAY) == end_day {
                    break;
                }
                assert_eq!(wall.div_euclid(DAY), day, "{name} {at}: one slot a day");
                assert_eq!(latest_slot(&daily, slot, offset_at), Some(slot), "{name} {at}");
                if previous.is_some() {
                    assert_eq!(latest_slot(&daily, slot - 1, offset_at), previous, "{name} {at}");
                }
                let late = wall.rem_euclid(DAY) / MINUTE - wall_minutes(at).expect("a time");
                if late != 0 {
                    // Skipped: as long after the change as it was after the skipped part began.
                    assert_eq!(late, i64::from(offset_at(slot) - offset_at(slot - 12 * HOUR)), "{name} {at}");
                    moved += 1;
                }
                for passes_apart in [30 * MINUTE, 60 * MINUTE] {
                    assert_ne!(wall_clock(slot - passes_apart, offset_at), wall, "{name} {at}: the first pass");
                    if wall_clock(slot + passes_apart, offset_at) == wall {
                        first_pass += 1;
                    }
                }
                (day, previous, after) = (day + 1, Some(slot), slot);
            }
            assert_eq!(day, end_day, "{name} {at}: every day of five years");
        }
        assert_eq!((moved, first_pass), (skipped, doubled), "{name}");
    }
}

#[test]
fn slots_a_change_of_the_clocks_lands_on_one_instant_are_one_slot() {
    let ny = zone("America/New_York");
    let ny: OffsetAt<'_> = &ny;
    // 02:00 to 02:50 run at 03:00 to 03:50; the window's own 03:00 is the same instant as 02:00's.
    let spring = repeat(json!({"every": 10, "between": ["01:00", "03:00"], "days": "all"}));
    let found = slots(&spring, utc("2026-03-08T05:00Z"), utc("2026-03-09T04:00Z"), ny);
    let expected: Vec<i64> = (0..12).map(|step| utc("2026-03-08T06:00Z") + step * 10 * MINUTE).collect();
    assert_eq!(found, expected);
    let fired = state(&spring, 0, Some(utc("2026-03-08T06:00Z")));
    let missed = due(&fired, utc("2026-03-08T07:55Z"), ny).map(|due| (due.slot, due.missed));
    assert_eq!(missed, Some((utc("2026-03-08T07:50Z"), 10)), "03:00 is missed once");
    // 01:00 to 01:50 run once, at the first pass; 02:00 is winter time.
    let fall = repeat(json!({"every": 10, "between": ["01:00", "02:00"], "days": "all"}));
    let found = slots(&fall, utc("2026-11-01T04:00Z"), utc("2026-11-02T05:00Z"), ny);
    let mut expected: Vec<i64> = (0..6).map(|step| utc("2026-11-01T05:00Z") + step * 10 * MINUTE).collect();
    expected.push(utc("2026-11-01T07:00Z"));
    assert_eq!(found, expected);
    // Lord Howe skips half an hour: 02:00 and 02:15 run at 02:30 and 02:45; 02:30 is 02:00's.
    let lord_howe = zone("Australia/Lord_Howe");
    let quarter = repeat(json!({"every": 15, "between": ["01:30", "02:30"], "days": "all"}));
    let found = slots(&quarter, utc("2026-10-03T13:30Z"), utc("2026-10-04T13:00Z"), &lord_howe);
    let expected: Vec<i64> = (0..4).map(|step| utc("2026-10-03T15:00Z") + step * 15 * MINUTE).collect();
    assert_eq!(found, expected);
}

fn state(repeat: &Repeat, armed_at: i64, last_slot_at: Option<i64>) -> ScheduleState<'_> {
    ScheduleState { repeat, armed_at, last_slot_at }
}

#[test]
fn a_schedule_armed_after_its_slot_waits_for_the_next() {
    let utc0: OffsetAt<'_> = &|_| 0;
    let daily = repeat(json!({"daily": "05:00", "days": "all"}));
    let armed = state(&daily, utc("2026-03-10T14:00Z"), None);
    assert_eq!(due(&armed, utc("2026-03-10T14:01Z"), utc0), None);
    assert_eq!(due(&armed, utc("2026-03-11T04:59Z"), utc0), None);
    assert_eq!(
        due(&armed, utc("2026-03-11T05:10Z"), utc0),
        Some(Due { slot: utc("2026-03-11T05:00Z"), missed: 0, late_by: 10 * MINUTE })
    );
    // Armed on the slot itself: it fires.
    let on_time = state(&daily, utc("2026-03-11T05:00Z"), None);
    assert_eq!(due(&on_time, utc("2026-03-11T05:00Z"), utc0).map(|due| due.late_by), Some(0));
    // Resumed after a pause: nothing from the pause fires or counts as missed.
    let resumed = state(&daily, utc("2026-03-14T14:00Z"), Some(utc("2026-03-10T05:00Z")));
    assert_eq!(due(&resumed, utc("2026-03-14T15:00Z"), utc0), None);
    assert_eq!(due(&resumed, utc("2026-03-15T05:00Z"), utc0).map(|due| due.missed), Some(0));
}

#[test]
fn after_sleep_or_a_jump_ahead_the_latest_slot_fires_once_and_counts_the_rest() {
    let utc0: OffsetAt<'_> = &|_| 0;
    let hourly = repeat(json!({"every": 60, "days": "all"}));
    let slept = state(&hourly, 0, Some(utc("2026-03-10T22:00Z")));
    assert_eq!(
        due(&slept, utc("2026-03-11T06:10Z"), utc0),
        Some(Due { slot: utc("2026-03-11T06:00Z"), missed: 7, late_by: 10 * MINUTE })
    );
    let daily = repeat(json!({"daily": "05:00", "days": "all"}));
    let away = state(&daily, 0, Some(utc("2026-03-10T05:00Z")));
    let week_later = due(&away, utc("2026-03-17T06:00Z"), utc0).expect("due");
    assert_eq!((week_later.slot, week_later.missed), (utc("2026-03-17T05:00Z"), 6));
    // Never fired: the slots since arming count.
    let new = state(&daily, utc("2026-03-10T04:00Z"), None);
    assert_eq!(due(&new, utc("2026-03-12T05:30Z"), utc0).map(|due| due.missed), Some(2));
    // A slot that fired is not due again.
    let fired = state(&daily, 0, Some(utc("2026-03-17T05:00Z")));
    assert_eq!(due(&fired, utc("2026-03-17T06:00Z"), utc0), None);
}

#[test]
fn a_clock_set_back_fires_nothing_twice_and_a_day_ahead_resets() {
    let utc0: OffsetAt<'_> = &|_| 0;
    let daily = repeat(json!({"daily": "05:00", "days": "all"}));
    let fired = state(&daily, 0, Some(utc("2026-03-10T05:00Z")));
    // Set back two hours, then the clock passes 05:00 again.
    for now in ["2026-03-10T03:30Z", "2026-03-10T05:00Z", "2026-03-10T05:30Z"] {
        assert!(!clock_reset(&fired, utc(now)), "{now}");
        assert_eq!(due(&fired, utc(now), utc0), None, "{now}");
    }
    assert_eq!(due(&fired, utc("2026-03-11T05:00Z"), utc0).map(|due| due.slot), Some(utc("2026-03-11T05:00Z")));
    // A slot fired three years ahead: the clock was wrong. Nothing fires, and the scheduler resets once.
    let ahead = state(&daily, 0, Some(utc("2029-03-10T05:00Z")));
    let now = utc("2026-03-10T09:00Z");
    assert!(clock_reset(&ahead, now));
    assert_eq!(due(&ahead, now, utc0), None);
    let reset = state(&daily, 0, Some(now));
    assert!(!clock_reset(&reset, now));
    assert_eq!(due(&reset, utc("2026-03-11T05:00Z"), utc0).map(|due| due.missed), Some(0));
    // Less than a day ahead is not a wrong clock.
    let close = state(&daily, 0, Some(utc("2026-03-11T05:00Z")));
    assert!(!clock_reset(&close, now));
}
