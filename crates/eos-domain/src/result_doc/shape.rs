//! The shape of a result kind, as the channel that sends it declares it:
//! the one source of what a run's lead is told to hand in, of what its
//! checker is told the result looks like, and of the check that refuses a
//! result of another shape. Every refusal names the part, what is wrong and
//! what the shape expects, so the lead can fix it from the text alone.

use eos_contracts::{Part, ResultDoc};
use serde_json::Value;

/// What a result of one kind looks like.
#[derive(Debug, Clone)]
pub struct ResultShape {
    pub kind: String,
    /// The channel that sends it.
    pub channel: String,
    /// The channel's actions that send it; the first is the usual one.
    pub actions: Vec<String>,
    pub parts: Vec<PartShape>,
    /// What else the lead must know to write one, one sentence each.
    pub notes: Vec<String>,
}

/// One part of a result, or every part no other one names.
#[derive(Debug, Clone)]
pub struct PartShape {
    pub key: PartKey,
    pub role: String,
    /// What the part is, read as "a line comment".
    pub name: String,
    pub required: bool,
    /// What the part holds.
    pub what: String,
    /// The texts it may have; empty when any text will do.
    pub values: Vec<String>,
    pub meta: Vec<MetaShape>,
    /// What to do instead when a part lacks its required meta.
    pub otherwise: Option<String>,
    pub example: String,
}

/// How a part is keyed.
#[derive(Debug, Clone)]
pub enum PartKey {
    /// Exactly this key, at most once.
    One(String),
    /// Every part no [`PartKey::One`] names, keyed by number from 1.
    Each(fn(usize) -> String),
}

/// One field of a part's `meta`.
#[derive(Debug, Clone)]
pub struct MetaShape {
    pub name: String,
    pub required: bool,
    pub value: MetaValue,
    pub what: String,
    pub example: Value,
}

/// What a meta field may hold.
#[derive(Debug, Clone)]
pub enum MetaValue {
    Text,
    /// A line number: a whole number from 1.
    Line,
    OneOf(Vec<String>),
}

impl ResultShape {
    /// The shape as the lead and the checker read it, ending with an example
    /// in a `json` block that passes [`ResultShape::check`].
    pub fn describe(&self) -> String {
        let mut lines = vec![
            format!("Hand in kind `{}`. Its `body` is one object, not plain text:", self.kind),
            format!("- `kind`: `{}`", self.kind),
            format!("- `channel`: `{}`", self.channel),
            format!("- `action`: {}", one_of(&self.actions)),
            "- `parts`: a list of `{key, role, text, meta}` objects:".to_owned(),
        ];
        for part in &self.parts {
            let key = match &part.key {
                PartKey::One(key) => format!("`{key}`"),
                PartKey::Each(key) => format!("`{}`, `{}`, … (each other part)", key(1), key(2)),
            };
            let need = if part.required { "required" } else { "optional" };
            let mut line = format!("  - {key}, role `{}`, {need}: {}", part.role, part.what);
            if !part.values.is_empty() {
                line.push_str(&format!(" Its text is {}.", one_of(&part.values)));
            }
            lines.push(line);
            for meta in &part.meta {
                let need = if meta.required { "required" } else { "optional" };
                let value = match &meta.value {
                    MetaValue::Text => String::new(),
                    MetaValue::Line => " A whole number from 1.".to_owned(),
                    MetaValue::OneOf(values) => format!(" {}.", capital(&one_of(values))),
                };
                lines.push(format!("    - `meta.{}`, {need}: {}{value}", meta.name, meta.what));
            }
        }
        lines.extend(self.notes.iter().cloned());
        let example = serde_json::to_string_pretty(&self.example()).unwrap_or_default();
        lines.push(format!("Example of `body`:\n```json\n{example}\n```"));
        lines.join("\n")
    }

    /// A result of this shape with every part once.
    pub fn example(&self) -> ResultDoc {
        let parts = self
            .parts
            .iter()
            .map(|part| Part {
                key: match &part.key {
                    PartKey::One(key) => key.clone(),
                    PartKey::Each(key) => key(1),
                },
                role: part.role.clone(),
                text: part.example.clone(),
                meta: part.meta.iter().map(|meta| (meta.name.clone(), meta.example.clone())).collect(),
            })
            .collect();
        ResultDoc {
            kind: self.kind.clone(),
            channel: self.channel.clone(),
            action: self.actions.first().cloned().unwrap_or_default(),
            parts,
        }
    }

    /// What in `doc` does not fit the shape, one line each; empty when it fits.
    pub fn check(&self, doc: &ResultDoc) -> Vec<String> {
        let mut found = Vec::new();
        if doc.kind != self.kind {
            found.push(format!("body `kind` is `{}`: it must be `{}`.", doc.kind, self.kind));
        }
        if doc.channel.is_empty() && doc.action.is_empty() {
            found.push(
                "body: hand in the whole result as one object with kind, channel, action and parts, as the brief's \
                 example shows."
                    .to_owned(),
            );
        } else {
            if doc.channel != self.channel {
                found.push(format!("`channel` is `{}`: a {} goes through `{}`.", doc.channel, self.kind, self.channel));
            }
            if !self.actions.contains(&doc.action) {
                found.push(format!("`action` is `{}`: it must be {}.", doc.action, one_of(&self.actions)));
            }
        }
        for (at, part) in doc.parts.iter().enumerate() {
            if doc.parts[..at].iter().any(|before| before.key == part.key) {
                found.push(format!("part `{}`: two parts have this key; give each part its own key.", part.key));
            }
        }
        for decl in self.parts.iter().filter(|decl| decl.required) {
            if let PartKey::One(key) = &decl.key
                && !doc.parts.iter().any(|part| part.key == *key)
            {
                found.push(format!("part `{key}` is missing: {}", decl.what));
            }
        }
        for part in &doc.parts {
            match self.declared(&part.key) {
                Some(decl) => decl.check(part, &mut found),
                None => found.push(format!("part `{}`: a {} has no such part.", part.key, self.kind)),
            }
        }
        found
    }

    /// The declaration of the part keyed `key`: its own, else the one for
    /// every other part.
    fn declared(&self, key: &str) -> Option<&PartShape> {
        let own = self.parts.iter().find(|decl| matches!(&decl.key, PartKey::One(one) if one == key));
        own.or_else(|| self.parts.iter().find(|decl| matches!(decl.key, PartKey::Each(_))))
    }
}

impl PartShape {
    fn check(&self, part: &Part, found: &mut Vec<String>) {
        let key = &part.key;
        if !self.values.is_empty() && !self.values.contains(&part.text) {
            found.push(format!("part `{key}`: its text must be {}.", one_of(&self.values)));
        }
        let missing: Vec<String> = self
            .meta
            .iter()
            .filter(|meta| meta.required && !part.meta.contains_key(&meta.name))
            .map(|meta| format!("meta.{}", meta.name))
            .collect();
        if !missing.is_empty() {
            let otherwise = self.otherwise.as_ref().map(|text| format!("; {text}")).unwrap_or_default();
            found.push(format!("part `{key}`: a {} needs {}{otherwise}.", self.name, missing.join(" and ")));
        }
        for meta in &self.meta {
            if let Some(value) = part.meta.get(&meta.name)
                && let Some(wanted) = meta.refuses(value)
            {
                found.push(format!("part `{key}`: meta.{} must be {wanted}.", meta.name));
            }
        }
    }
}

impl MetaShape {
    /// What `value` should have been, when it is not what the field holds.
    fn refuses(&self, value: &Value) -> Option<String> {
        match &self.value {
            MetaValue::Text => (!value.is_string()).then(|| "text".to_owned()),
            MetaValue::Line => {
                (value.as_u64().unwrap_or(0) == 0).then(|| "a line number, a whole number from 1".to_owned())
            }
            MetaValue::OneOf(values) => {
                (!value.as_str().is_some_and(|text| values.iter().any(|v| v == text))).then(|| one_of(values))
            }
        }
    }
}

/// What keeps `body`, handed in as an object, from reading as a result:
/// each field it lacks or holds as the wrong type, one line each; empty when
/// it reads. Names fields and part keys only, never their text.
pub fn body_misfits(body: &Value) -> Vec<String> {
    let Some(fields) = body.as_object() else { return Vec::new() };
    let mut found = Vec::new();
    for name in ["kind", "channel", "action"] {
        match fields.get(name) {
            None => found.push(format!("body: `{name}` is missing; the body holds kind, channel, action and parts.")),
            Some(value) if !value.is_string() => found.push(format!("body: `{name}` must be text.")),
            Some(_) => {}
        }
    }
    let Some(parts) = fields.get("parts").and_then(Value::as_array) else {
        found.push("body: `parts` must be a list of `{key, role, text, meta}` objects.".to_owned());
        return found;
    };
    for (at, part) in parts.iter().enumerate() {
        let Some(part) = part.as_object() else {
            found.push(format!("part {}: must be an object with key, role, text and meta.", at + 1));
            continue;
        };
        let name = match part.get("key").and_then(Value::as_str) {
            Some(key) => format!("part `{key}`"),
            None => format!("part {}", at + 1),
        };
        for field in ["key", "role", "text"] {
            if !part.get(field).is_some_and(Value::is_string) {
                found.push(format!("{name}: `{field}` is missing or not text; every part has key, role and text."));
            }
        }
        if part.get("meta").is_some_and(|meta| !meta.is_object()) {
            found.push(format!("{name}: `meta` must be an object."));
        }
    }
    found
}

/// `` `a` ``, or `` one of `a`, `b` ``.
fn one_of(values: &[String]) -> String {
    let quoted: Vec<String> = values.iter().map(|value| format!("`{value}`")).collect();
    match quoted.as_slice() {
        [one] => one.clone(),
        _ => format!("one of {}", quoted.join(", ")),
    }
}

fn capital(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests;
