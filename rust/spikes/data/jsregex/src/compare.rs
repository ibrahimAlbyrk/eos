//! Compares an engine with what Node did (ts/regex-expected.ts) on a pattern set.

use std::panic;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{JsMatch, engines::Engine, substitute};

#[derive(Debug, Deserialize)]
pub struct Cases {
    pub patterns: Vec<Case>,
    pub inputs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct Case {
    pub pattern: String,
    #[serde(rename = "rewriteTo")]
    pub rewrite_to: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Default)]
pub struct Report {
    pub patterns: usize,
    pub identical: usize,
    pub compile_disagreement: usize,
    pub match_disagreement: usize,
    pub inputs_compared: usize,
    pub inputs_identical: usize,
    pub runtime_errors: usize,
    /// One line per pattern that is not identical.
    pub notes: Vec<String>,
}

/// Node's output as serde_json can read it.
pub fn parse_expected(text: &str) -> serde_json::Result<Vec<Value>> {
    serde_json::from_str(&lossy_surrogates(text))
}

// A match can cut a surrogate pair in half. Both sides turn such a half into
// U+FFFD before comparing: here with from_utf16_lossy, there in lossy_surrogates.
fn text_of(units: &[u16]) -> Value {
    json!(String::from_utf16_lossy(units))
}

fn replace(m: Option<&JsMatch>, text: &str, template: &str) -> String {
    let Some(m) = m else { return text.to_owned() };
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = m.index + m.whole.len();
    let mut out = units[..m.index].to_vec();
    substitute(m, &units[..m.index], &units[end..], template, &mut out);
    out.extend_from_slice(&units[end..]);
    String::from_utf16_lossy(&out)
}

pub fn run(engine: &dyn Engine, cases: &[Case], expected: &[Value], inputs: &[String]) -> Report {
    let mut rep = Report { patterns: cases.len(), ..Report::default() };
    for (case, want) in cases.iter().zip(expected) {
        let js_rejects = want.get("error").is_some();
        let note = case.note.as_deref().unwrap_or("");
        let re = match (engine.compile(&case.pattern), js_rejects) {
            (Err(_), true) => {
                rep.identical += 1;
                continue;
            }
            (Err(e), false) => {
                rep.compile_disagreement += 1;
                rep.notes.push(format!("rejects   {:?}  ({note})  — {}", case.pattern, e.lines().next().unwrap_or("")));
                continue;
            }
            (Ok(_), true) => {
                rep.compile_disagreement += 1;
                rep.notes.push(format!("accepts   {:?}  ({note})  — JavaScript throws", case.pattern));
                continue;
            }
            (Ok(re), false) => re,
        };
        let mut differ = 0;
        let mut first = None;
        for (text, w) in inputs.iter().zip(want["results"].as_array().into_iter().flatten()) {
            rep.inputs_compared += 1;
            let got = match panic::catch_unwind(panic::AssertUnwindSafe(|| re.exec(text))) {
                Ok(Ok(m)) => m,
                Ok(Err(_)) | Err(_) => {
                    rep.runtime_errors += 1;
                    differ += 1;
                    first.get_or_insert_with(|| format!("error on {text:?}"));
                    continue;
                }
            };
            let want_index = w["index"].as_i64().unwrap_or(-1);
            let mut same = match &got {
                None => want_index == -1,
                Some(m) => {
                    want_index == m.index as i64
                        && text_of(&m.whole) == w["match"]
                        && w["groups"].as_array().is_some_and(|g| {
                            g.len() == m.groups.len()
                                && g.iter()
                                    .zip(&m.groups)
                                    .all(|(a, b)| *a == b.as_ref().map_or(Value::Null, |u| text_of(u)))
                        })
                }
            };
            if let (true, Some(template)) = (same, &case.rewrite_to) {
                same = w["replaced"].as_str() == Some(replace(got.as_ref(), text, template).as_str());
            }
            if same {
                rep.inputs_identical += 1;
            } else {
                differ += 1;
                first.get_or_insert_with(|| format!("on {text:?}"));
            }
        }
        if differ == 0 {
            rep.identical += 1;
        } else {
            rep.match_disagreement += 1;
            rep.notes.push(format!(
                "differs   {:?}  ({note})  — {differ} inputs, first {}",
                case.pattern,
                first.unwrap_or_default()
            ));
        }
    }
    rep
}

/// Replaces `\uD800`–`\uDFFF` escapes that are not part of a pair with `�`,
/// so serde_json can read Node's output. (Same on both sides: Rust builds its
/// strings with `from_utf16_lossy`.)
pub fn lossy_surrogates(json: &str) -> String {
    let b = json.as_bytes();
    let mut out = String::with_capacity(json.len());
    let mut i = 0;
    let unit = |at: usize| -> Option<u16> {
        (b.get(at) == Some(&b'\\') && b.get(at + 1) == Some(&b'u'))
            .then(|| std::str::from_utf8(b.get(at + 2..at + 6)?).ok().and_then(|h| u16::from_str_radix(h, 16).ok()))
            .flatten()
    };
    while i < b.len() {
        // A backslash escaping a backslash: copy both, so "\\ud800" stays text.
        if b[i] == b'\\' && b.get(i + 1) == Some(&b'\\') {
            out.push_str("\\\\");
            i += 2;
            continue;
        }
        match unit(i) {
            Some(hi @ 0xD800..=0xDBFF) => match unit(i + 6) {
                Some(0xDC00..=0xDFFF) => {
                    out.push_str(&json[i..i + 12]);
                    i += 12;
                }
                _ => {
                    let _ = hi;
                    out.push_str("\\ufffd");
                    i += 6;
                }
            },
            Some(0xDC00..=0xDFFF) => {
                out.push_str("\\ufffd");
                i += 6;
            }
            _ => {
                let ch = json[i..].chars().next().expect("in bounds");
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    out
}
