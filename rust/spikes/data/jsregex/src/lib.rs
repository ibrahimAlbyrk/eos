//! Spike 7: ECMAScript regexes from user data (`policy.yaml` matchers,
//! `rewriteFrom`, worker-definition `editRegex`) in Rust.
//!
//! Eos compiles them with `new RegExp(pattern)` — no flags — and uses `.test()`
//! and `String.prototype.replace(re, template)`. `JsRegex` is that contract on
//! `regress`: the pattern is compiled without the unicode flag and matched over
//! UTF-16 code units, exactly like a flagless JavaScript regex, and `replace`
//! expands JavaScript's replacement tokens.

use std::ops::Range;

pub mod compare;
pub mod engines;

#[derive(Debug)]
pub struct JsRegex {
    re: regress::Regex,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsMatch {
    /// Start of the match in UTF-16 code units, as `RegExp#exec().index`.
    pub index: usize,
    /// The match and the groups as UTF-16; a group that took no part is `None`.
    pub whole: Vec<u16>,
    pub groups: Vec<Option<Vec<u16>>>,
    pub named: Vec<(String, Option<Vec<u16>>)>,
}

impl JsRegex {
    /// `new RegExp(pattern)`: `Err` is JavaScript's SyntaxError.
    pub fn new(pattern: &str) -> Result<Self, regress::Error> {
        let re = regress::Regex::with_flags(pattern, regress::Flags::default())?;
        Ok(Self { re })
    }

    /// `re.test(text)`
    pub fn test(&self, text: &str) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.re.find_from_ucs2(&units, 0).next().is_some()
    }

    /// `re.exec(text)`
    pub fn exec(&self, text: &str) -> Option<JsMatch> {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.exec_units(&units)
    }

    fn exec_units(&self, units: &[u16]) -> Option<JsMatch> {
        let m = self.re.find_from_ucs2(units, 0).next()?;
        let slice = |r: &Range<usize>| units[r.clone()].to_vec();
        let named = m.named_groups().map(|(name, r)| (name.to_owned(), r.as_ref().map(slice))).collect();
        Some(JsMatch {
            index: m.range.start,
            whole: slice(&m.range),
            groups: m.captures.iter().map(|c| c.as_ref().map(slice)).collect(),
            named,
        })
    }

    /// `text.replace(re, template)` for a regex without the g flag: the first
    /// match only, with `$$ $& $\` $' $n $nn $<name>` expanded.
    pub fn replace(&self, text: &str, template: &str) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        let Some(m) = self.exec_units(&units) else { return text.to_owned() };
        let end = m.index + m.whole.len();
        let mut out: Vec<u16> = units[..m.index].to_vec();
        substitute(&m, &units[..m.index], &units[end..], template, &mut out);
        out.extend_from_slice(&units[end..]);
        String::from_utf16_lossy(&out)
    }
}

/// ECMAScript GetSubstitution.
pub fn substitute(m: &JsMatch, before: &[u16], after: &[u16], template: &str, out: &mut Vec<u16>) {
    let t: Vec<u16> = template.encode_utf16().collect();
    let dollar = u16::from(b'$');
    let digit = |u: u16| (u16::from(b'0')..=u16::from(b'9')).contains(&u).then(|| usize::from(u - u16::from(b'0')));
    let mut i = 0;
    while i < t.len() {
        if t[i] != dollar || i + 1 >= t.len() {
            out.push(t[i]);
            i += 1;
            continue;
        }
        let next = t[i + 1];
        if next == dollar {
            out.push(dollar);
            i += 2;
        } else if next == u16::from(b'&') {
            out.extend_from_slice(&m.whole);
            i += 2;
        } else if next == u16::from(b'`') {
            out.extend_from_slice(before);
            i += 2;
        } else if next == u16::from(b'\'') {
            out.extend_from_slice(after);
            i += 2;
        } else if let Some(d1) = digit(next) {
            // Two digits when that names a group, else one; $0 and unknown
            // numbers stay as written.
            let two = t.get(i + 2).copied().and_then(digit).map(|d2| d1 * 10 + d2);
            let (n, len) = match two {
                Some(n) if (1..=m.groups.len()).contains(&n) => (n, 3),
                _ => (d1, 2),
            };
            if (1..=m.groups.len()).contains(&n) {
                if let Some(g) = &m.groups[n - 1] {
                    out.extend_from_slice(g);
                }
            } else {
                out.extend_from_slice(&t[i..i + len]);
            }
            i += len;
        } else if next == u16::from(b'<') && !m.named.is_empty() {
            match t[i + 2..].iter().position(|u| *u == u16::from(b'>')) {
                Some(close) => {
                    let name = String::from_utf16_lossy(&t[i + 2..i + 2 + close]);
                    if let Some((_, Some(g))) = m.named.iter().find(|(n, _)| *n == name) {
                        out.extend_from_slice(g);
                    }
                    i += close + 3;
                }
                None => {
                    out.push(dollar);
                    i += 1;
                }
            }
        } else {
            out.push(dollar);
            i += 1;
        }
    }
}
