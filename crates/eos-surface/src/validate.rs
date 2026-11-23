//! Checks data against a type and answers with every problem at once, so an
//! agent fixes its whole fill in one more call. Fields the type does not name
//! are warnings: they never fail a fill, and the renderer never sees them.

use serde_json::Value;

use crate::problem::{Problem, field_path, index_path};
use crate::types::{Field, Type};

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Validation {
    pub problems: Vec<Problem>,
    pub warnings: Vec<Problem>,
}

impl Validation {
    pub fn is_ok(&self) -> bool {
        self.problems.is_empty()
    }
}

pub fn validate(ty: &Type, data: &Value) -> Validation {
    let mut out = Validation::default();
    check(ty, data, "", &mut out);
    out
}

fn check(ty: &Type, value: &Value, path: &str, out: &mut Validation) {
    let mut wrong = |message: String| out.problems.push(Problem::new(path, message));
    match ty {
        Type::Text { max } | Type::LongText { max } => match value.as_str() {
            None => wrong("must be text".into()),
            Some(text) => {
                if matches!(ty, Type::Text { .. }) && text.contains('\n') {
                    wrong("must be one line".into());
                }
                let chars = text.chars().count();
                if chars > *max {
                    wrong(format!("is {chars} characters, max {max}"));
                }
            }
        },
        Type::Number => {
            if !value.is_number() {
                wrong("must be a number".into());
            }
        }
        Type::Int => {
            if !(value.is_i64() || value.is_u64()) {
                wrong("must be a whole number".into());
            }
        }
        Type::Bool => {
            if !value.is_boolean() {
                wrong("must be true or false".into());
            }
        }
        Type::Date => {
            if !value.as_str().is_some_and(is_date) {
                wrong("must be a date like 2026-11-24".into());
            }
        }
        Type::DateTime => {
            if !value.as_str().is_some_and(is_datetime) {
                wrong("must be a date and time like 2026-11-24T07:00:00Z".into());
            }
        }
        Type::Url => {
            if !value.as_str().is_some_and(is_web_url) {
                wrong("must be an http or https address".into());
            }
        }
        Type::Image => check_image(value, path, out),
        Type::Enum { values } => {
            if !value.as_str().is_some_and(|v| values.iter().any(|allowed| allowed == v)) {
                wrong(format!("must be one of {}", values.join(", ")));
            }
        }
        Type::Object { fields } => check_object(fields, value, path, out),
        Type::List { of, min, max } => match value.as_array() {
            None => wrong("must be a list".into()),
            Some(items) => {
                if items.len() < *min {
                    wrong(format!("has {} items, min {min}", items.len()));
                }
                if items.len() > *max {
                    wrong(format!("has {} items, max {max}", items.len()));
                }
                for (i, item) in items.iter().enumerate().take(*max) {
                    check(of, item, &index_path(path, i), out);
                }
            }
        },
    }
}

fn check_object(fields: &[Field], value: &Value, path: &str, out: &mut Validation) {
    let Some(map) = value.as_object() else {
        out.problems.push(Problem::new(path, "must be an object"));
        return;
    };
    for field in fields {
        let here = field_path(path, &field.name);
        match map.get(&field.name) {
            None | Some(Value::Null) if field.required => out.problems.push(Problem::new(here, "is required")),
            None | Some(Value::Null) => {}
            Some(found) => check(&field.ty, found, &here, out),
        }
    }
    for key in map.keys().filter(|k| !fields.iter().any(|f| &f.name == *k)) {
        out.warnings.push(Problem::new(field_path(path, key), "is not in the contract and is ignored"));
    }
}

fn check_image(value: &Value, path: &str, out: &mut Validation) {
    let fields = [
        Field::required("src", Type::Url),
        Field::required("alt", Type::Text { max: 300 }),
        Field::optional("credit", Type::Text { max: 200 }),
    ];
    check_object(&fields, value, path, out);
}

pub(crate) fn is_web_url(text: &str) -> bool {
    let rest = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://"));
    rest.is_some_and(|r| {
        let host = r.split(['/', '?', '#']).next().unwrap_or_default();
        !host.is_empty() && !text.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}

pub(crate) fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (number(&text[0..4]), number(&text[5..7]), number(&text[8..10])) else {
        return false;
    };
    (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
}

fn is_datetime(text: &str) -> bool {
    if text.len() < 20 || !is_date(&text[..10]) || !matches!(text.as_bytes()[10], b'T' | b't') {
        return false;
    }
    let rest = &text[11..];
    let (clock, zone) = match rest.find(['Z', 'z', '+', '-']) {
        Some(i) => rest.split_at(i),
        None => return false,
    };
    let clock = clock.split('.').collect::<Vec<_>>();
    let fraction_ok = clock.get(1).is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()));
    let hms: Vec<_> = clock[0].split(':').map(number).collect();
    let time_ok = matches!(hms.as_slice(), [Some(h), Some(m), Some(s)] if *h < 24 && *m < 60 && *s < 61)
        && clock[0].len() == 8
        && clock.len() <= 2;
    let zone_ok = matches!(zone, "Z" | "z")
        || (zone.len() == 6
            && zone.as_bytes()[3] == b':'
            && number(&zone[1..3]).is_some_and(|h| h < 24)
            && number(&zone[4..6]).is_some_and(|m| m < 60));
    fraction_ok && time_ok && zone_ok
}

fn number(digits: &str) -> Option<u32> {
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
