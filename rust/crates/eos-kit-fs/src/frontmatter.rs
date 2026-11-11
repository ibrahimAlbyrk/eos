//! Markdown with frontmatter (pages, memories, worker definitions): YAML
//! metadata between `---` fences, then the body verbatim.
//!
//! Reading goes through `serde_norway`; writing through this crate's port of
//! the `yaml` package's writer, so a file keeps its layout whichever app wrote it last.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_norway::Value;

use crate::error::Error;
use crate::yaml::to_yaml;

/// The fence every reader shares, `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/`:
/// returns the YAML between the fences and the body after them.
///
/// Its corners, kept on purpose: the closing fence is the first `\n---`, even
/// when more follows on that line; `---\n---` (nothing between) is not
/// frontmatter; a byte-order mark before the first fence means no frontmatter.
pub fn split(raw: &str) -> Option<(&str, &str)> {
    let after_open = raw.strip_prefix("---\r\n").or_else(|| raw.strip_prefix("---\n"))?;
    let close = after_open.find("\n---")?;
    // A CR before the closing line feed belongs to the fence, not the YAML.
    let yaml = after_open[..close].strip_suffix('\r').unwrap_or(&after_open[..close]);
    let mut body = &after_open[close + "\n---".len()..];
    body = body.strip_prefix('\r').unwrap_or(body);
    body = body.strip_prefix('\n').unwrap_or(body);
    Some((yaml, body))
}

/// Mapping keys as a JavaScript object holds them: always strings.
fn string_keys(value: Value) -> Value {
    match value {
        Value::Mapping(map) => Value::Mapping(
            map.into_iter()
                .map(|(key, value)| {
                    let key = match key {
                        Value::String(_) => key,
                        Value::Bool(b) => Value::String(b.to_string()),
                        Value::Number(n) => Value::String(n.to_string()),
                        Value::Null => Value::String("null".to_owned()),
                        other => other,
                    };
                    (key, string_keys(value))
                })
                .collect(),
        ),
        Value::Sequence(items) => Value::Sequence(items.into_iter().map(string_keys).collect()),
        other => other,
    }
}

/// Splits a file and reads its metadata as `T`. `Ok(None)` when the file has
/// no frontmatter or it is not a mapping; an error when the YAML does not
/// parse or does not fit `T`. Merge keys (`<<`) stay ordinary keys.
pub fn parse<T: DeserializeOwned>(raw: &str) -> Result<Option<(T, &str)>, Error> {
    let Some((yaml, body)) = split(raw) else { return Ok(None) };
    let value: Value = serde_norway::from_str(yaml).map_err(|e| Error::Yaml(e.to_string()))?;
    if !value.is_mapping() {
        return Ok(None);
    }
    let meta = serde_norway::from_value(string_keys(value)).map_err(|e| Error::Yaml(e.to_string()))?;
    Ok(Some((meta, body)))
}

/// What JavaScript's `trimEnd` removes.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `---\n<yaml>\n---\n<body>`, the metadata laid out as today's writer lays it out.
pub fn join<T: Serialize + ?Sized>(meta: &T, body: &str) -> Result<String, Error> {
    let yaml = to_yaml(meta)?;
    Ok(format!("---\n{}\n---\n{body}", yaml.trim_end_matches(is_js_whitespace)))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[test]
    fn the_fence_corners() {
        assert_eq!(split("---\na: 1\n---\nbody\n"), Some(("a: 1", "body\n")));
        assert_eq!(split("---\r\na: 1\r\n---\r\nbody"), Some(("a: 1", "body")));
        assert_eq!(split("---\na: 1\n---"), Some(("a: 1", "")));
        assert_eq!(split("---\na: 1\n----\nrest"), Some(("a: 1", "-\nrest")));
        assert_eq!(split("---\n---\nbody\n"), None);
        assert_eq!(split("---\n\n---\nbody\n"), Some(("", "body\n")));
        assert_eq!(split("\u{feff}---\na: 1\n---\n"), None);
        assert_eq!(split("# no fence\n---\n"), None);
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Meta {
        id: String,
        title: String,
        project: Option<String>,
        rev: u32,
        created_at: f64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tags: Vec<String>,
    }

    fn meta() -> Meta {
        Meta {
            id: "p_1".to_owned(),
            title: "Notes: day one".to_owned(),
            project: None,
            rev: 3,
            created_at: 1_767_225_600_000.0,
            tags: vec!["a".to_owned(), "yes".to_owned()],
        }
    }

    #[test]
    fn a_file_is_written_in_field_order_and_reads_back() {
        let file = join(&meta(), "# Body\n\n---\nnot a fence\n").expect("join");
        assert_eq!(
            file,
            "---\nid: p_1\ntitle: \"Notes: day one\"\nproject: null\nrev: 3\ncreatedAt: 1767225600000\ntags:\n  - a\n  - yes\n---\n# Body\n\n---\nnot a fence\n"
        );
        let (read, body) = parse::<Meta>(&file).expect("parse").expect("frontmatter");
        assert_eq!(read, meta());
        assert_eq!(body, "# Body\n\n---\nnot a fence\n");
    }

    #[test]
    fn no_frontmatter_or_a_non_mapping_is_none_and_bad_yaml_is_an_error() {
        assert!(parse::<Meta>("# just markdown\n").expect("parse").is_none());
        assert!(parse::<Value>("---\n- a\n- b\n---\nbody").expect("parse").is_none());
        assert!(parse::<Value>("---\njust a string\n---\nbody").expect("parse").is_none());
        assert!(parse::<Value>("---\n\n---\nbody").expect("parse").is_none());
        assert!(matches!(parse::<Value>("---\na: [unclosed\n---\nbody"), Err(Error::Yaml(_))));
        assert!(matches!(parse::<Meta>("---\nid: 5\n---\nbody"), Err(Error::Yaml(_))), "does not fit the type");
    }

    #[test]
    fn keys_are_strings_and_merge_keys_stay_ordinary_keys() {
        #[derive(Debug, Deserialize)]
        struct Loose {
            #[serde(rename = "1")]
            one: String,
            #[serde(rename = "true")]
            yes: String,
            #[serde(rename = "<<")]
            merge: std::collections::BTreeMap<String, i32>,
        }
        let (loose, _) =
            parse::<Loose>("---\n1: a\ntrue: b\n<<: { x: 1 }\n---\n").expect("parse").expect("frontmatter");
        assert_eq!((loose.one.as_str(), loose.yes.as_str()), ("a", "b"));
        assert_eq!(loose.merge.get("x"), Some(&1));
    }
}
