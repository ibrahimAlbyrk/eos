//! Reading YAML the way today's files are read.
//!
//! The TypeScript app reads frontmatter with the `yaml` package: YAML 1.2,
//! core schema. `serde_norway` is the parser here; where the two disagree
//! about what a document means, this module sides with the package:
//!
//! - characters YAML 1.2 allows in text but the parser refuses or takes for
//!   line breaks (see [`is_foreign`]) are carried through;
//! - a plain scalar is a number only when the core schema says so: `0b11`,
//!   `-0x1f`, `+0o7` and the like are strings;
//! - mapping keys are strings, as in a JavaScript object;
//! - a block scalar that ends the text keeps its final line feed, whether or
//!   not the text ends with a line break.
//!
//! Not covered: a plain decimal with leading zeros (`010`) stays a string
//! here and is the number 10 there. The package's own writer quotes such a
//! string, so the difference needs a hand-written file.

use std::fmt;
use std::sync::LazyLock;

use regress::Regex;
use serde::Deserialize;
use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_norway::Value;

use crate::error::Error;

/// Characters the `yaml` package writes as they are (YAML 1.2) but the reader
/// here, a YAML 1.1 one, refuses or takes for line breaks: DEL and the C1
/// controls, the Unicode line and paragraph separators, U+FEFF and the two
/// non-characters.
fn is_foreign(c: char) -> bool {
    matches!(c, '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{feff}' | '\u{fffe}' | '\u{ffff}')
}

/// Stands in for the foreign characters while the YAML is parsed: each
/// becomes `<mark><hex><mark>`, ordinary text to the reader, and is put back
/// in every key and string afterwards.
struct Foreign {
    mark: char,
}

impl Foreign {
    /// `None` when `yaml` holds no foreign character (or no private-use
    /// character is free to mark them, which no real file comes near).
    fn hide(yaml: &str) -> Option<(Self, String)> {
        if !yaml.contains(is_foreign) {
            return None;
        }
        let mark = ('\u{e000}'..='\u{f8ff}').find(|c| !yaml.contains(*c))?;
        let mut hidden = String::with_capacity(yaml.len() + 16);
        for c in yaml.chars() {
            if is_foreign(c) {
                hidden.push(mark);
                hidden.push_str(&format!("{:x}", u32::from(c)));
                hidden.push(mark);
            } else {
                hidden.push(c);
            }
        }
        Some((Self { mark }, hidden))
    }

    fn restore(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut parts = text.split(self.mark);
        out.push_str(parts.next().unwrap_or_default());
        while let (Some(hex), Some(after)) = (parts.next(), parts.next()) {
            match u32::from_str_radix(hex, 16).ok().and_then(char::from_u32) {
                Some(c) => out.push(c),
                None => out.push_str(hex),
            }
            out.push_str(after);
        }
        out
    }
}

/// Mapping keys as a JavaScript object holds them (always strings), and every
/// string with its foreign characters back.
fn finish(value: Value, foreign: Option<&Foreign>) -> Value {
    let text = |s: String| foreign.map_or_else(|| s.clone(), |f| f.restore(&s));
    match value {
        Value::Mapping(map) => Value::Mapping(
            map.into_iter()
                .map(|(key, value)| {
                    let key = match key {
                        Value::String(s) => Value::String(text(s)),
                        Value::Bool(b) => Value::String(b.to_string()),
                        Value::Number(n) => Value::String(n.to_string()),
                        Value::Null => Value::String("null".to_owned()),
                        other => other,
                    };
                    (key, finish(value, foreign))
                })
                .collect(),
        ),
        Value::Sequence(items) => Value::Sequence(items.into_iter().map(|item| finish(item, foreign)).collect()),
        Value::String(s) => Value::String(text(s)),
        other => other,
    }
}

/// What the core schema reads as a number: the package's own tests, in its order
/// (`schema/core/int.js`, `float.js`).
fn is_core_number(text: &str) -> bool {
    static NUMBER: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        let patterns = [
            r"^[-+]?[0-9]+$",
            r"^0o[0-7]+$",
            r"^0x[0-9a-fA-F]+$",
            r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$",
            r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$",
            r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$",
        ];
        // Literals of this file; the tests run every one.
        patterns.iter().map(|p| Regex::new(p).unwrap_or_else(|e| panic!("regex {p}: {e}"))).collect()
    });
    NUMBER.iter().any(|re| re.find(text).is_some())
}

/// A second walk over the document, guided by the value the first one gave:
/// wherever the parser saw a number, the scalar's own text is read, and it
/// becomes a string unless the core schema reads it as a number too.
struct CoreNumbers<'a>(&'a mut Value);

impl<'de> DeserializeSeed<'de> for CoreNumbers<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, de: D) -> Result<(), D::Error> {
        match self.0 {
            Value::Number(_) => {
                let text = String::deserialize(de)?;
                if !is_core_number(&text) {
                    *self.0 = Value::String(text);
                }
                Ok(())
            }
            Value::Mapping(_) | Value::Sequence(_) => de.deserialize_any(self),
            _ => IgnoredAny::deserialize(de).map(drop),
        }
    }
}

impl<'de> Visitor<'de> for CoreNumbers<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the document read a moment ago")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let Value::Mapping(entries) = self.0 else { return Ok(()) };
        for (_, value) in entries.iter_mut() {
            if map.next_key::<IgnoredAny>()?.is_none() {
                break;
            }
            map.next_value_seed(CoreNumbers(value))?;
        }
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let Value::Sequence(items) = self.0 else { return Ok(()) };
        for item in items {
            if seq.next_element_seed(CoreNumbers(item))?.is_none() {
                break;
            }
        }
        Ok(())
    }
}

/// `yaml.parse(text)`, as far as plain data goes.
pub fn read_yaml(yaml: &str) -> Result<Value, Error> {
    // Frontmatter is cut out of its file without its last line break. The
    // package still gives a block scalar on the last line its final line
    // feed; the parser here only does when the break is there.
    let closed;
    let yaml = if yaml.is_empty() || yaml.ends_with('\n') {
        yaml
    } else {
        closed = format!("{yaml}\n");
        &closed
    };
    let hidden = Foreign::hide(yaml);
    let (foreign, yaml) = match &hidden {
        Some((foreign, text)) => (Some(foreign), text.as_str()),
        None => (None, yaml),
    };
    let failed = |e: serde_norway::Error| Error::Yaml(e.to_string());
    let mut value: Value = serde_norway::from_str(yaml).map_err(failed)?;
    CoreNumbers(&mut value).deserialize(serde_norway::Deserializer::from_str(yaml)).map_err(failed)?;
    Ok(finish(value, foreign))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(yaml: &str) -> Value {
        read_yaml(yaml).expect("reads")
    }

    #[test]
    fn a_plain_scalar_is_a_number_only_when_the_core_schema_says_so() {
        // What `yaml.parse` gives for each: a string for the first group, a number for the second.
        for text in ["0b11", "-0b1", "-0x1f", "+0x1F", "-0o7", "+0o7", "1_000", "0x_1"] {
            let value = read(&format!("a: {text}\nb:\n  - {text}\n  - c: {text}\n"));
            assert_eq!(value["a"], Value::String(text.to_owned()), "{text}");
            assert_eq!(value["b"][0], Value::String(text.to_owned()), "{text} in a list");
            assert_eq!(value["b"][1]["c"], Value::String(text.to_owned()), "{text} nested");
        }
        for (text, number) in
            [("31", 31.0), ("-7", -7.0), ("0x1f", 31.0), ("0o17", 15.0), ("1.5", 1.5), ("1e3", 1000.0), (".5", 0.5)]
        {
            assert_eq!(read(&format!("a: {text}\n"))["a"].as_f64(), Some(number), "{text}");
        }
        assert!(read("a: .inf\n")["a"].as_f64().is_some_and(f64::is_infinite));
        assert_eq!(read("a: \"0x1f\"\n")["a"], Value::String("0x1f".to_owned()), "quoted is a string");
    }

    #[test]
    fn a_block_scalar_on_the_last_line_keeps_its_final_line_feed() {
        // Frontmatter is cut out of its file without its last line break.
        // What `yaml.parse` gives for each text:
        for (yaml, text) in [
            ("a: |\n  one\n  two", "one\ntwo\n"),
            ("a: |\n  one\n  two\n", "one\ntwo\n"),
            ("a: |+\n  one\n  two", "one\ntwo\n"),
            ("a: |-\n  one\n  two", "one\ntwo"),
            ("a: >\n  one\n  two", "one two\n"),
            ("b: 1\na: |\n  one", "one\n"),
            ("a: |\n  one\n\n", "one\n"),
        ] {
            assert_eq!(read(yaml)["a"], Value::String(text.to_owned()), "{yaml:?}");
        }
        assert_eq!(read("- |\n  x")[0], Value::String("x\n".to_owned()));
        assert_eq!(read("a: plain"), read("a: plain\n"));
        assert_eq!(read(""), Value::Null);
    }

    #[test]
    fn anchors_tags_and_other_scalars_pass_through_the_second_walk() {
        let value = read("a: &n -0x1f\nb: *n\nc: ~\nd: true\ne: text\nf: !custom 3\ng: [1, {h: 0b1}]\n");
        assert_eq!(value["a"], Value::String("-0x1f".to_owned()));
        assert_eq!(value["b"], Value::String("-0x1f".to_owned()));
        assert_eq!((value["c"].clone(), value["d"].clone()), (Value::Null, Value::Bool(true)));
        assert_eq!(value["e"], Value::String("text".to_owned()));
        assert!(matches!(value["f"], Value::Tagged(_)));
        assert_eq!(value["g"][0].as_i64(), Some(1));
        assert_eq!(value["g"][1]["h"], Value::String("0b1".to_owned()));
        assert_eq!(read("5\n").as_i64(), Some(5));
        assert_eq!(read("-0b1\n"), Value::String("-0b1".to_owned()));
        assert!(read_yaml("a: [unclosed\n").is_err());
    }
}
