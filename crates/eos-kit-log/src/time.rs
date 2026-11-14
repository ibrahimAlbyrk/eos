//! The wall-clock time of a log line, in the form the core's lines carry
//! (`2026-11-14T20:30:01.123456Z`).

use std::time::{SystemTime, UNIX_EPOCH};

pub fn utc_now() -> String {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format_utc(since.as_secs(), since.subsec_micros())
}

pub(crate) fn format_utc(secs: u64, micros: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{micros:06}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 → (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_as_the_core_lines_do() {
        assert_eq!(format_utc(0, 0), "1970-01-01T00:00:00.000000Z");
        assert_eq!(format_utc(1_794_256_201, 123_456), "2026-11-09T20:30:01.123456Z");
        assert_eq!(format_utc(951_782_400, 7), "2000-02-29T00:00:00.000007Z");
    }
}
