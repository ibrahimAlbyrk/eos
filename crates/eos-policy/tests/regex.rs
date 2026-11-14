//! `JsRegex` against Node: `tests/fixtures/regex-*.json` holds 72 patterns
//! (the shipped rules, lookaround, named groups, backreferences, Annex B
//! corners, things only other engines accept) and what Node did with each on
//! 86 inputs — whether the pattern compiles, where it matches, what the match
//! and its groups hold, and what `replace` returns.

use eos_policy::JsRegex;
use eos_policy::js::JsMatch;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Cases {
    patterns: Vec<Case>,
    inputs: Vec<String>,
}

#[derive(Deserialize)]
struct Case {
    pattern: String,
    #[serde(rename = "rewriteTo")]
    rewrite_to: Option<String>,
}

/// Node's output holds lone surrogates (a match can cut a pair in half);
/// both sides turn such a half into U+FFFD before comparing.
fn lossy_surrogates(json: &str) -> String {
    let b = json.as_bytes();
    let mut out = String::with_capacity(json.len());
    let mut i = 0;
    let unit = |at: usize| -> Option<u16> {
        (b.get(at) == Some(&b'\\') && b.get(at + 1) == Some(&b'u'))
            .then(|| std::str::from_utf8(b.get(at + 2..at + 6)?).ok().and_then(|h| u16::from_str_radix(h, 16).ok()))
            .flatten()
    };
    while i < b.len() {
        if b[i] == b'\\' && b.get(i + 1) == Some(&b'\\') {
            out.push_str("\\\\");
            i += 2;
            continue;
        }
        match unit(i) {
            Some(0xD800..=0xDBFF) if matches!(unit(i + 6), Some(0xDC00..=0xDFFF)) => {
                out.push_str(&json[i..i + 12]);
                i += 12;
            }
            Some(0xD800..=0xDFFF) => {
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

fn text_of(units: &[u16]) -> Value {
    json!(String::from_utf16_lossy(units))
}

fn same_match(got: Option<&JsMatch>, want: &Value) -> bool {
    let want_index = want["index"].as_i64().unwrap_or(-1);
    match got {
        None => want_index == -1,
        Some(m) => {
            i64::try_from(m.index) == Ok(want_index)
                && text_of(&m.whole) == want["match"]
                && want["groups"].as_array().is_some_and(|groups| {
                    groups.len() == m.groups.len()
                        && groups
                            .iter()
                            .zip(&m.groups)
                            .all(|(a, b)| *a == b.as_ref().map_or(Value::Null, |u| text_of(u)))
                })
        }
    }
}

#[test]
fn every_probe_behaves_as_in_node() {
    let cases: Cases = serde_json::from_str(include_str!("fixtures/regex-probes.json")).expect("probes");
    let expected: Vec<Value> =
        serde_json::from_str(&lossy_surrogates(include_str!("fixtures/regex-expected.json"))).expect("expected");
    assert!(cases.patterns.len() >= 70 && cases.inputs.len() >= 80);
    assert_eq!(cases.patterns.len(), expected.len());

    let mut differences = Vec::new();
    for (case, want) in cases.patterns.iter().zip(&expected) {
        let re = match (JsRegex::new(&case.pattern), want.get("error").is_some()) {
            (Err(_), true) => continue,
            (Err(e), false) => {
                differences.push(format!("rejects {:?}: {e}", case.pattern));
                continue;
            }
            (Ok(_), true) => {
                differences.push(format!("accepts {:?}, JavaScript throws", case.pattern));
                continue;
            }
            (Ok(re), false) => re,
        };
        let results = want["results"].as_array().expect("results");
        for (text, w) in cases.inputs.iter().zip(results) {
            let got = re.exec(text);
            let mut same = same_match(got.as_ref(), w);
            if let (true, Some(template)) = (same, &case.rewrite_to) {
                same = w["replaced"].as_str() == Some(re.replace(text, template).as_str());
            }
            if !same {
                differences.push(format!("{:?} on {text:?}", case.pattern));
            }
        }
    }
    assert!(differences.is_empty(), "differences:\n{}", differences.join("\n"));
}
