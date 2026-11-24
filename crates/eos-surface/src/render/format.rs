//! A slot's value as the text a page shows: escaped always, formatted when
//! the slot names a format, dates in the reader's own offset.

use serde_json::Value;

use crate::template::Format;

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/// Text for HTML text and attribute values alike.
pub(crate) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Marks that turn the direction of the text around them.
pub(crate) fn has_bidi_controls(text: &str) -> bool {
    text.chars().any(|c| matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
}

/// A scalar value as plain text, before escaping. `offset` is the reader's
/// offset from UTC in minutes.
pub(crate) fn plain(value: &Value, format: Option<&Format>, offset: i32) -> String {
    match format {
        None => match value {
            Value::String(text) => text.clone(),
            Value::Number(n) => number(n.as_f64().unwrap_or_default()),
            Value::Bool(b) => if *b { "yes" } else { "no" }.to_owned(),
            _ => String::new(),
        },
        Some(format) => {
            let Some(text) = value.as_str() else {
                let n = value.as_f64().unwrap_or_default();
                return match format {
                    Format::Count(word) => count(n, word),
                    _ => number(n),
                };
            };
            let Some(at) = Civil::read(text, offset) else { return text.to_owned() };
            match format {
                Format::Date => format!("{} {} {}", at.day, MONTHS[at.month as usize - 1], at.year),
                Format::Weekday => WEEKDAYS[at.weekday()].to_owned(),
                Format::Time => format!("{:02}:{:02}", at.hour, at.minute),
                Format::DateTime => {
                    format!("{} {} {}, {:02}:{:02}", at.day, MONTHS[at.month as usize - 1], at.year, at.hour, at.minute)
                }
                Format::Number | Format::Count(_) => text.to_owned(),
            }
        }
    }
}

/// `12,345` or `3.5`.
fn number(n: f64) -> String {
    if n.fract() != 0.0 || n.abs() >= 1e15 {
        return n.to_string();
    }
    #[allow(clippy::cast_possible_truncation)]
    let whole = n as i64;
    let digits = whole.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if whole < 0 { format!("-{out}") } else { out }
}

/// `1 review`, `3 reviews`.
fn count(n: f64, word: &str) -> String {
    let plural = if (n - 1.0).abs() < f64::EPSILON {
        word.to_owned()
    } else if word.ends_with('s') || word.ends_with('x') || word.ends_with("sh") || word.ends_with("ch") {
        format!("{word}es")
    } else if word.ends_with('y') && !word.ends_with("ay") && !word.ends_with("ey") && !word.ends_with("oy") {
        format!("{}ies", &word[..word.len() - 1])
    } else {
        format!("{word}s")
    };
    format!("{} {plural}", number(n))
}

/// A wall-clock moment in the reader's offset.
struct Civil {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    days: i64,
}

impl Civil {
    /// `YYYY-MM-DD` (a date has no time and no offset) or RFC 3339 with an
    /// offset, moved into `offset`.
    fn read(text: &str, offset: i32) -> Option<Civil> {
        let num = |s: &str| s.parse::<i64>().ok();
        let year = num(text.get(0..4)?)?;
        let month = num(text.get(5..7)?)?;
        let day = num(text.get(8..10)?)?;
        if text.as_bytes().get(4) != Some(&b'-') || text.as_bytes().get(7) != Some(&b'-') {
            return None;
        }
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let days = days_from_civil(year, month, day);
        if text.len() == 10 {
            return Some(Civil::at(days * 1440));
        }
        let rest = text.get(10..)?;
        let rest = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '))?;
        let hour = num(rest.get(0..2)?)?;
        let minute = num(rest.get(3..5)?)?;
        let zone_at = rest.find(['Z', 'z', '+', '-'])?;
        let zone = &rest[zone_at..];
        let zone_minutes = if zone.eq_ignore_ascii_case("z") {
            0
        } else {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            sign * (num(zone.get(1..3)?)? * 60 + num(zone.get(4..6)?)?)
        };
        let utc = days * 1440 + hour * 60 + minute - zone_minutes;
        Some(Civil::at(utc + i64::from(offset)))
    }

    fn at(minutes: i64) -> Civil {
        let days = minutes.div_euclid(1440);
        let of_day = minutes.rem_euclid(1440);
        let (year, month, day) = civil_from_days(days);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Civil { year, month, day, hour: (of_day / 60) as u32, minute: (of_day % 60) as u32, days }
    }

    /// 0 is Monday.
    fn weekday(&self) -> usize {
        // 1970-01-01 was a Thursday.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let index = (self.days + 3).rem_euclid(7) as usize;
        index
    }
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
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
    use serde_json::json;

    use super::*;

    #[test]
    fn dates_times_numbers_and_counts_read_as_people_write_them() {
        assert_eq!(plain(&json!("2026-11-17"), Some(&Format::Date), 180), "17 November 2026");
        assert_eq!(plain(&json!("2026-11-17"), Some(&Format::Weekday), 0), "Tuesday");
        assert_eq!(plain(&json!("2026-11-17T02:30:00Z"), Some(&Format::Time), 180), "05:30");
        assert_eq!(plain(&json!("2026-11-16T23:30:00-01:00"), Some(&Format::DateTime), 0), "17 November 2026, 00:30");
        assert_eq!(plain(&json!(12345), None, 0), "12,345");
        assert_eq!(plain(&json!(-1234567), Some(&Format::Number), 0), "-1,234,567");
        assert_eq!(plain(&json!(2.5), None, 0), "2.5");
        assert_eq!(plain(&json!(1), Some(&Format::Count("review".into())), 0), "1 review");
        assert_eq!(plain(&json!(3), Some(&Format::Count("story".into())), 0), "3 stories");
        assert_eq!(plain(&json!(0), Some(&Format::Count("pass".into())), 0), "0 passes");
        assert_eq!(escape("<b a=\"x\">&'"), "&lt;b a=&quot;x&quot;&gt;&amp;&#39;");
    }
}
