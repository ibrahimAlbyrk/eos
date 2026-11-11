//! Telling the wall-clock times of a run from the fixed times a seed wrote.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// How far from "now" a time still counts as this run's.
const WINDOW_MS: i64 = 2 * 24 * 60 * 60 * 1000;

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)?").expect("iso pattern")
});
static EPOCH_MS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d{13}\b").expect("epoch pattern"));

/// True for an epoch time (milliseconds or seconds) near `now_ms`.
pub fn is_recent_epoch(value: f64, now_ms: i64) -> bool {
    #[allow(clippy::cast_precision_loss)]
    let (now, window) = (now_ms as f64, WINDOW_MS as f64);
    (value - now).abs() <= window || (value * 1000.0 - now).abs() <= window
}

/// Replaces every ISO date-time and epoch-millisecond number in `text` that is near `now_ms`.
pub fn replace_recent(text: &str, now_ms: i64, with: &str) -> String {
    let recent = |ms: i64| (ms - now_ms).abs() <= WINDOW_MS;
    let dates = ISO.replace_all(text, |hit: &Captures<'_>| match iso_ms(hit) {
        // Without a zone the time is local: any offset keeps it inside the window's slack.
        Some(ms) if recent(ms) || (hit.get(7).is_none() && (ms - now_ms).abs() <= WINDOW_MS + 14 * 3_600_000) => {
            with.to_owned()
        }
        _ => hit[0].to_owned(),
    });
    EPOCH_MS
        .replace_all(&dates, |hit: &Captures<'_>| match hit[0].parse::<i64>() {
            Ok(ms) if recent(ms) => with.to_owned(),
            _ => hit[0].to_owned(),
        })
        .into_owned()
}

fn iso_ms(hit: &Captures<'_>) -> Option<i64> {
    let field = |i: usize| hit.get(i)?.as_str().parse::<i64>().ok();
    let (year, month, day) = (field(1)?, field(2)?, field(3)?);
    let (hour, minute, second) = (field(4)?, field(5)?, field(6)?);
    let offset_minutes = match hit.get(7).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(zone) => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let (h, m) = zone[1..].split_once(':')?;
            sign * (h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?)
        }
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1000)
}

/// Days since 1970-01-01 in the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y.rem_euclid(400);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-11T12:00:00Z.
    const NOW: i64 = 1_794_398_400_000;

    #[test]
    fn civil_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2026, 11, 11) * 86_400_000 + 12 * 3_600_000, NOW);
    }

    #[test]
    fn epochs_near_now() {
        assert!(is_recent_epoch(1_794_398_400_000.0, NOW));
        assert!(is_recent_epoch(1_794_398_460.0, NOW));
        assert!(!is_recent_epoch(1_790_000_000_000.0, NOW));
        assert!(!is_recent_epoch(7500.0, NOW));
    }

    #[test]
    fn replaces_only_what_is_near() {
        assert_eq!(replace_recent("a 2026-11-11T12:00:01Z b", NOW, "<now>"), "a <now> b");
        assert_eq!(replace_recent("2026-11-12T01:30:00.5+03:00", NOW, "<now>"), "<now>");
        assert_eq!(replace_recent("2026-09-01T10:00:00Z", NOW, "<now>"), "2026-09-01T10:00:00Z");
        assert_eq!(replace_recent("id 1794398400123 and 1790000000000", NOW, "<now>"), "id <now> and 1790000000000");
        assert_eq!(replace_recent("17943984001234", NOW, "<now>"), "17943984001234");
    }
}
