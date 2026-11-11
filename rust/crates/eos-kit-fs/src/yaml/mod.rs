//! Writing YAML the way today's files are written.
//!
//! The TypeScript app writes frontmatter with the `yaml` package (2.x,
//! `stringify` with its defaults), whose layout no Rust YAML library
//! reproduces: long plain scalars folded at 80 columns, block scalars for
//! multi-line text, sequences indented under their key. This is a port of the
//! part of its writer that plain data reaches (`stringify.js`,
//! `stringifyPair.js`, `stringifyCollection.js`, `stringifyString.js`,
//! `foldFlowLines.js`), so a file rewritten here keeps its bytes.
//!
//! The port works on UTF-16 code units, as the original does: widths and
//! fold points count what JavaScript's `length` counts. `tests/yaml_vectors.rs`
//! checks it against vectors the package itself produced.

mod fold;
mod string;

use serde_norway::Value;

use crate::error::Error;

pub(crate) type Units = Vec<u16>;

pub(crate) const NL: u16 = b'\n' as u16;
pub(crate) const SP: u16 = b' ' as u16;
pub(crate) const TAB: u16 = b'\t' as u16;

pub(crate) fn units(s: &str) -> Units {
    s.encode_utf16().collect()
}

pub(crate) fn push_str(out: &mut Units, s: &str) {
    out.extend(s.encode_utf16());
}

pub(crate) fn push_spaces(out: &mut Units, n: usize) {
    out.extend(std::iter::repeat_n(SP, n));
}

const INDENT_STEP: usize = 2;

/// The writer's context. Indents are always runs of spaces, so a count stands in for the string.
#[derive(Debug, Clone, Default)]
pub(crate) struct Ctx {
    pub(crate) indent: usize,
    pub(crate) implicit_key: bool,
    pub(crate) indent_at_start: Option<usize>,
    pub(crate) force_block_indent: bool,
}

/// `yaml.stringify(value)`: the document text, with its final line feed.
pub fn to_yaml<T: serde::Serialize + ?Sized>(value: &T) -> Result<String, Error> {
    let value = serde_norway::to_value(value).map_err(|e| Error::Yaml(e.to_string()))?;
    let mut chomp_keep = false;
    let mut out = node(&value, &Ctx::default(), &mut chomp_keep)?;
    out.push(NL);
    String::from_utf16(&out).map_err(|e| Error::Yaml(e.to_string()))
}

/// How JavaScript prints a number (`JSON.stringify`), plus YAML's names for the non-finite ones.
fn number(n: &serde_norway::Number) -> String {
    const SAFE: u64 = 1 << 53;
    if let Some(i) = n.as_i64().filter(|i| i.unsigned_abs() <= SAFE) {
        return i.to_string();
    }
    if let Some(u) = n.as_u64().filter(|u| *u <= SAFE) {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f.is_nan() {
        ".nan".to_owned()
    } else if f.is_infinite() {
        if f < 0.0 { "-.inf" } else { ".inf" }.to_owned()
    } else if f == 0.0 && f.is_sign_negative() {
        "-0".to_owned()
    } else {
        ryu_js::Buffer::new().format(f).to_owned()
    }
}

/// A mapping key as the string a JavaScript object would hold.
fn key_text(key: &Value) -> Result<String, Error> {
    match key {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(number(n)),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Ok("null".to_owned()),
        _ => Err(Error::Yaml("a mapping key must be a scalar".to_owned())),
    }
}

fn is_collection(value: &Value) -> bool {
    matches!(value, Value::Sequence(_) | Value::Mapping(_))
}

fn node(value: &Value, ctx: &Ctx, chomp_keep: &mut bool) -> Result<Units, Error> {
    Ok(match value {
        Value::Null => units("null"),
        Value::Bool(b) => units(if *b { "true" } else { "false" }),
        Value::Number(n) => units(&number(n)),
        Value::String(s) => string::stringify(&units(s), ctx, chomp_keep),
        Value::Sequence(items) => {
            if items.is_empty() {
                return Ok(units("[]"));
            }
            let item_ctx = Ctx { indent: ctx.indent + INDENT_STEP, ..ctx.clone() };
            let mut lines = Vec::with_capacity(items.len());
            for item in items {
                *chomp_keep = false;
                let mut line = units("- ");
                line.extend(node(item, &item_ctx, chomp_keep)?);
                lines.push(line);
            }
            join_lines(lines, ctx.indent)
        }
        Value::Mapping(map) => {
            if map.is_empty() {
                return Ok(units("{}"));
            }
            let mut lines = Vec::with_capacity(map.len());
            for (key, value) in map {
                *chomp_keep = false;
                lines.push(pair(&key_text(key)?, value, ctx, chomp_keep)?);
            }
            join_lines(lines, ctx.indent)
        }
        Value::Tagged(_) => return Err(Error::Yaml("tagged values are not written".to_owned())),
    })
}

fn join_lines(lines: Vec<Units>, indent: usize) -> Units {
    let mut out = Units::new();
    for (i, line) in lines.into_iter().enumerate() {
        if i > 0 {
            out.push(NL);
            push_spaces(&mut out, indent);
        }
        out.extend(line);
    }
    out
}

// stringifyPair.js, for a plain string key.
fn pair(key: &str, value: &Value, ctx: &Ctx, chomp_keep: &mut bool) -> Result<Units, Error> {
    let mut ctx = Ctx { indent: ctx.indent + INDENT_STEP, implicit_key: true, ..ctx.clone() };
    let mut key_chomp = false;
    let mut out = string::stringify(&units(key), &ctx, &mut key_chomp);
    // A key too long for one line is written as an explicit key.
    let explicit_key = out.len() > 1024;
    if explicit_key {
        let mut explicit = units("? ");
        explicit.extend(out);
        explicit.push(NL);
        push_spaces(&mut explicit, ctx.indent - INDENT_STEP);
        explicit.push(u16::from(b':'));
        out = explicit;
    } else {
        out.push(u16::from(b':'));
    }

    ctx.implicit_key = false;
    if !explicit_key && !is_collection(value) {
        ctx.indent_at_start = Some(out.len() + 1);
    }
    let mut value_chomp = false;
    let text = node(value, &ctx, &mut value_chomp)?;

    if !explicit_key && is_collection(value) {
        // An empty collection is written inline (`[]`, `{}`); any other starts on its own line.
        let empty = match value {
            Value::Sequence(items) => items.is_empty(),
            Value::Mapping(map) => map.is_empty(),
            _ => false,
        };
        if text.contains(&NL) || !empty {
            out.push(NL);
            push_spaces(&mut out, ctx.indent);
        } else {
            out.push(SP);
        }
    } else if !(text.is_empty() || text[0] == NL) {
        out.push(SP);
    }
    out.extend(text);
    if value_chomp {
        *chomp_keep = true;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let yaml = |v: f64| to_yaml(&v).expect("yaml");
        assert_eq!(yaml(1_767_225_600_000.0), "1767225600000\n");
        assert_eq!(yaml(1.0), "1\n");
        assert_eq!(yaml(-0.0), "-0\n");
        assert_eq!(yaml(1e21), "1e+21\n");
        assert_eq!(yaml(0.1 + 0.2), "0.30000000000000004\n");
        assert_eq!(yaml(f64::NAN), ".nan\n");
        assert_eq!(yaml(f64::NEG_INFINITY), "-.inf\n");
        assert_eq!(to_yaml(&u64::MAX).expect("yaml"), "18446744073709552000\n");
        assert_eq!(to_yaml(&-42i64).expect("yaml"), "-42\n");
    }

    #[test]
    fn struct_fields_keep_their_order_and_skipped_ones_are_absent() {
        #[derive(serde::Serialize)]
        struct Meta {
            zebra: u8,
            #[serde(skip_serializing_if = "Option::is_none")]
            absent: Option<u8>,
            apple: Option<u8>,
        }
        assert_eq!(to_yaml(&Meta { zebra: 1, absent: None, apple: None }).expect("yaml"), "zebra: 1\napple: null\n");
    }
}
