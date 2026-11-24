//! Slots: `{path}` or `{path|format}` inside text and attribute values. A
//! value always goes in as text; `{{` and `}}` write a brace.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seg {
    Lit(String),
    Slot(Slot),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub path: String,
    pub format: Option<Format>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Format {
    Date,
    Time,
    DateTime,
    Weekday,
    Number,
    /// A number with a word after it, made plural past one: `3 reviews`.
    Count(String),
}

impl Format {
    fn parse(text: &str) -> Option<Format> {
        Some(match text {
            "date" => Format::Date,
            "time" => Format::Time,
            "datetime" => Format::DateTime,
            "weekday" => Format::Weekday,
            "number" => Format::Number,
            _ => {
                let word = text.strip_prefix("count:")?;
                if word.is_empty() || !word.chars().all(char::is_alphabetic) {
                    return None;
                }
                Format::Count(word.to_owned())
            }
        })
    }

    fn write(&self) -> String {
        match self {
            Format::Date => "date".into(),
            Format::Time => "time".into(),
            Format::DateTime => "datetime".into(),
            Format::Weekday => "weekday".into(),
            Format::Number => "number".into(),
            Format::Count(word) => format!("count:{word}"),
        }
    }
}

/// A path of names joined by dots: `lead.image.alt`.
pub(crate) fn is_path(text: &str) -> bool {
    !text.is_empty()
        && text.split('.').all(|name| {
            let mut chars = name.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

pub(crate) fn parse_segments(text: &str) -> Result<Vec<Seg>, String> {
    let mut segs = Vec::new();
    let mut lit = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(['{', '}']) {
        lit.push_str(&rest[..at]);
        let tail = &rest[at..];
        if let Some(after) = tail.strip_prefix("{{").or_else(|| tail.strip_prefix("}}")) {
            lit.push_str(&tail[..1]);
            rest = after;
            continue;
        }
        if tail.starts_with('}') {
            return Err("a } closes no slot; write }} for a brace".into());
        }
        let Some(close) = tail.find('}') else {
            return Err("a slot is never closed: write {path}, or {{ for a brace".into());
        };
        let body = &tail[1..close];
        let (path, format) = match body.split_once('|') {
            Some((path, format)) => (path.trim(), Some(format.trim())),
            None => (body.trim(), None),
        };
        if !is_path(path) {
            return Err(format!("{{{body}}} is not a slot: a slot names a field, as {{lead.title}}"));
        }
        let format = match format {
            None => None,
            Some(text) => Some(Format::parse(text).ok_or_else(|| {
                format!("{text} is not a format: date, time, datetime, weekday, number or count:<word>")
            })?),
        };
        if !lit.is_empty() {
            segs.push(Seg::Lit(std::mem::take(&mut lit)));
        }
        segs.push(Seg::Slot(Slot { path: path.to_owned(), format }));
        rest = &tail[close + 1..];
    }
    lit.push_str(rest);
    if !lit.is_empty() {
        segs.push(Seg::Lit(lit));
    }
    Ok(segs)
}

pub(crate) fn write_segments(segs: &[Seg]) -> String {
    let mut out = String::new();
    for seg in segs {
        match seg {
            Seg::Lit(text) => out.push_str(&text.replace('{', "{{").replace('}', "}}")),
            Seg::Slot(slot) => {
                out.push('{');
                out.push_str(&slot.path);
                if let Some(format) = &slot.format {
                    out.push('|');
                    out.push_str(&format.write());
                }
                out.push('}');
            }
        }
    }
    out
}
