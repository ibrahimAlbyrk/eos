//! Timestamps as text, the way JavaScript writes and reads them: stored rows
//! and wire payloads hold `Date.prototype.toISOString()` strings.

const MS_PER_DAY: i64 = 86_400_000;

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from(if month > 2 { month - 3 } else { month + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// `new Date(ms).toISOString()`: `2026-01-01T09:30:00.125Z`.
pub fn iso_from_ms(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(MS_PER_DAY));
    let of_day = ms.rem_euclid(MS_PER_DAY);
    let (h, m, s, milli) = (of_day / 3_600_000, of_day / 60_000 % 60, of_day / 1_000 % 60, of_day % 1_000);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

fn digits(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// `Date.parse` for the ISO forms the app and the providers write:
/// `YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by `Z` or `±HH:MM`. Anything
/// else is `None` (JavaScript's `NaN`).
pub fn ms_from_iso(text: &str) -> Option<i64> {
    let (date, rest) = text.trim().split_once('T')?;
    let mut ymd = date.splitn(3, '-');
    let (year, month, day) = (digits(ymd.next()?)?, digits(ymd.next()?)?, digits(ymd.next()?)?);
    let (clock, offset_min) = if let Some(clock) = rest.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = rest.rfind(['+', '-'])?;
        let (clock, zone) = rest.split_at(at);
        let (zh, zm) = zone[1..].split_once(':')?;
        let minutes = digits(zh)? * 60 + digits(zm)?;
        (clock, if zone.starts_with('-') { -minutes } else { minutes })
    };
    let (hms, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let mut parts = hms.splitn(3, ':');
    let (h, m) = (digits(parts.next()?)?, digits(parts.next()?)?);
    let s = parts.next().map_or(Some(0), digits)?;
    // Milliseconds: the first three fraction digits, as JavaScript keeps them.
    let milli = match fraction {
        "" => 0,
        f => digits(&format!("{f:0<3}")[..3])?,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || h > 24 || m > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(year, u32::try_from(month).ok()?, u32::try_from(day).ok()?);
    Some(days * MS_PER_DAY + h * 3_600_000 + m * 60_000 + s * 1_000 + milli - offset_min * 60_000)
}

/// `+03:00`, `-05:30`: minutes east of UTC as an offset.
fn offset_label(minutes: i32) -> String {
    let sign = if minutes < 0 { '-' } else { '+' };
    let abs = minutes.abs();
    format!("{sign}{:02}:{:02}", abs / 60, abs % 60)
}

/// An instant with the user's wall-clock reading of it, in a zone that is
/// `offset_minutes` east of UTC then (`core/src/use-cases/CurrentDateTime.ts`).
pub fn current_datetime(epoch_ms: i64, offset_minutes: i32, zone: &str) -> eos_contracts::CurrentDateTimeResponse {
    let offset = offset_label(offset_minutes);
    // The instant moved by the offset, read as UTC, is the local wall clock.
    let local = iso_from_ms(epoch_ms + i64::from(offset_minutes) * 60_000);
    let (date, time, millis) = (&local[..10], &local[11..19], &local[20..23]);
    eos_contracts::CurrentDateTimeResponse {
        epoch_ms,
        iso: format!("{date}T{time}.{millis}{offset}"),
        utc: iso_from_ms(epoch_ms),
        time_zone: zone.to_owned(),
        utc_offset_minutes: i64::from(offset_minutes),
        formatted: format!("{date} {time} UTC{offset} ({zone})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_what_to_iso_string_writes() {
        // new Date(Date.UTC(2026, 0, 1, 9, 30, 0, 125)).toISOString()
        assert_eq!(iso_from_ms(1_767_259_800_125), "2026-01-01T09:30:00.125Z");
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        // new Date(951782400000).toISOString(): a leap day.
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn reads_what_date_parse_reads() {
        assert_eq!(ms_from_iso("2026-01-01T09:30:00.125Z"), Some(1_767_259_800_125));
        // Date.parse("2026-11-11T16:40:00.123456+00:00") keeps milliseconds.
        assert_eq!(ms_from_iso("2026-01-01T09:30:00.125999+00:00"), Some(1_767_259_800_125));
        assert_eq!(ms_from_iso("2026-01-01T12:30:00+03:00"), Some(1_767_259_800_000));
        assert_eq!(ms_from_iso("2026-01-01T09:30Z"), Some(1_767_259_800_000));
        for bad in ["", "soon", "2026-01-01", "2026-13-01T00:00:00Z", "2026-01-01T09:30:00"] {
            assert_eq!(ms_from_iso(bad), None, "{bad}");
        }
        for ms in [0, 1_767_259_800_125, 951_782_400_000, 4_102_444_800_000] {
            assert_eq!(ms_from_iso(&iso_from_ms(ms)), Some(ms));
        }
    }
}
