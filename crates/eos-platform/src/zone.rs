//! Named time zones, read from the system's own zone files (`/usr/share/zoneinfo`, or the
//! folder `TZDIR` names); the app bundles no zone database. jiff lists the folder's names on
//! the first lookup and keeps each zone file it reads. Once a kept zone is five minutes old,
//! jiff checks the file's modification time before using it and reads the file again when it
//! changed. A name it does not know makes it list the folder again, at most once every five
//! minutes. No program is started: cheap enough for any thread, an async worker included.
//!
//! A name must be written exactly as the system's file is named: a schedule's zone is
//! compared with the user's own zone by its text.

use jiff::Timestamp;
use jiff::tz::TimeZone;

fn named(zone: &str) -> Option<TimeZone> {
    jiff::tz::db().get(zone).ok().filter(|found| found.iana_name() == Some(zone))
}

/// Minutes east of UTC in `zone` at `epoch_ms`, daylight saving included; `None` for a zone
/// the system does not know, or an instant out of range.
pub fn zone_offset_minutes(zone: &str, epoch_ms: i64) -> Option<i32> {
    let at = Timestamp::from_millisecond(epoch_ms).ok()?;
    Some(named(zone)?.to_offset(at).seconds() / 60)
}

/// The system has a zone of that name (`Europe/Istanbul`).
pub fn zone_known(zone: &str) -> bool {
    named(zone).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(utc: &str) -> i64 {
        utc.parse::<Timestamp>().expect("a UTC instant").as_millisecond()
    }

    /// Each zone's offset just before and at a change of its clocks, as `zdump -v` reads the
    /// same files.
    #[test]
    fn offsets_change_when_the_zone_files_say() {
        let changes = [
            ("America/New_York", "2026-03-08T07:00:00Z", -300, -240),
            ("America/New_York", "2026-11-01T06:00:00Z", -240, -300),
            ("America/New_York", "2030-03-10T07:00:00Z", -300, -240),
            ("Europe/London", "2026-03-29T01:00:00Z", 0, 60),
            ("Europe/London", "2026-10-25T01:00:00Z", 60, 0),
            ("Europe/London", "2030-10-27T01:00:00Z", 60, 0),
            // Half an hour of daylight saving.
            ("Australia/Lord_Howe", "2026-04-04T15:00:00Z", 660, 630),
            ("Australia/Lord_Howe", "2026-10-03T15:30:00Z", 630, 660),
            ("Australia/Lord_Howe", "2030-10-05T15:30:00Z", 630, 660),
            // Istanbul's last change: it has kept +03:00 since 2016.
            ("Europe/Istanbul", "2016-03-27T01:00:00Z", 120, 180),
        ];
        for (zone, change, before, after) in changes {
            let at = ms(change);
            assert_eq!(zone_offset_minutes(zone, at - 1), Some(before), "{zone} before {change}");
            assert_eq!(zone_offset_minutes(zone, at), Some(after), "{zone} at {change}");
        }
    }

    #[test]
    fn zones_without_daylight_saving_keep_one_offset() {
        for year in 2026..=2030 {
            for month in ["01", "07"] {
                let at = ms(&format!("{year}-{month}-15T12:00:00Z"));
                assert_eq!(zone_offset_minutes("Europe/Istanbul", at), Some(180), "{year}-{month}");
                assert_eq!(zone_offset_minutes("Asia/Kolkata", at), Some(330), "{year}-{month}");
                assert_eq!(zone_offset_minutes("UTC", at), Some(0), "{year}-{month}");
            }
        }
    }

    #[test]
    fn only_zones_the_system_has_are_known_by_their_exact_name() {
        for zone in ["Europe/Istanbul", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata", "UTC"] {
            assert!(zone_known(zone), "{zone}");
        }
        for zone in ["Mars/Base", "europe/istanbul", "", "../../etc/passwd"] {
            assert!(!zone_known(zone), "{zone:?}");
            assert_eq!(zone_offset_minutes(zone, 0), None, "{zone:?}");
        }
        assert_eq!(zone_offset_minutes("UTC", i64::MAX), None, "out of range");
    }
}
