//! The candidates behind one face, so the comparison treats them alike. Every
//! engine reports a match the way `RegExp#exec` would: index in UTF-16 units,
//! the match, the groups.

use crate::{JsMatch, JsRegex};

pub trait Engine {
    fn name(&self) -> &'static str;
    /// `Err` = the engine refuses the pattern.
    fn compile(&self, pattern: &str) -> Result<Box<dyn Compiled>, String>;
}

pub trait Compiled {
    fn exec(&self, text: &str) -> Result<Option<JsMatch>, String>;
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn index16(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}

// ---- regress, flagless, over UTF-16 code units (JavaScript's own model) -----

pub struct RegressUcs2;
impl Engine for RegressUcs2 {
    fn name(&self) -> &'static str {
        "regress 0.12 (code units)"
    }
    fn compile(&self, pattern: &str) -> Result<Box<dyn Compiled>, String> {
        Ok(Box::new(JsRegex::new(pattern).map_err(|e| e.to_string())?))
    }
}
impl Compiled for JsRegex {
    fn exec(&self, text: &str) -> Result<Option<JsMatch>, String> {
        Ok(JsRegex::exec(self, text))
    }
}

// ---- regress, flagless, over UTF-8 (`Regex::find`) --------------------------

pub struct RegressUtf8;
struct RegressUtf8Re(regress::Regex);
impl Engine for RegressUtf8 {
    fn name(&self) -> &'static str {
        "regress 0.12 (utf-8 str)"
    }
    fn compile(&self, pattern: &str) -> Result<Box<dyn Compiled>, String> {
        Ok(Box::new(RegressUtf8Re(regress::Regex::new(pattern).map_err(|e| e.to_string())?)))
    }
}
impl Compiled for RegressUtf8Re {
    fn exec(&self, text: &str) -> Result<Option<JsMatch>, String> {
        Ok(self.0.find(text).map(|m| JsMatch {
            index: index16(text, m.range.start),
            whole: utf16(&text[m.range.clone()]),
            groups: m.captures.iter().map(|c| c.as_ref().map(|r| utf16(&text[r.clone()]))).collect(),
            named: m.named_groups().map(|(n, r)| (n.to_owned(), r.map(|r| utf16(&text[r])))).collect(),
        }))
    }
}

// ---- regex ------------------------------------------------------------------

pub struct RustRegex;
struct RustRegexRe(regex::Regex);
impl Engine for RustRegex {
    fn name(&self) -> &'static str {
        "regex 1.13"
    }
    fn compile(&self, pattern: &str) -> Result<Box<dyn Compiled>, String> {
        Ok(Box::new(RustRegexRe(regex::Regex::new(pattern).map_err(|e| e.to_string())?)))
    }
}
impl Compiled for RustRegexRe {
    fn exec(&self, text: &str) -> Result<Option<JsMatch>, String> {
        Ok(self.0.captures(text).map(|c| {
            let whole = c.get(0).expect("group 0");
            JsMatch {
                index: index16(text, whole.start()),
                whole: utf16(whole.as_str()),
                groups: (1..c.len()).map(|i| c.get(i).map(|g| utf16(g.as_str()))).collect(),
                named: self
                    .0
                    .capture_names()
                    .flatten()
                    .map(|n| (n.to_owned(), c.name(n).map(|g| utf16(g.as_str()))))
                    .collect(),
            }
        }))
    }
}

// ---- fancy-regex --------------------------------------------------------------

pub struct FancyRegex;
struct FancyRegexRe(fancy_regex::Regex);
impl Engine for FancyRegex {
    fn name(&self) -> &'static str {
        "fancy-regex 0.20"
    }
    fn compile(&self, pattern: &str) -> Result<Box<dyn Compiled>, String> {
        Ok(Box::new(FancyRegexRe(fancy_regex::Regex::new(pattern).map_err(|e| e.to_string())?)))
    }
}
impl Compiled for FancyRegexRe {
    fn exec(&self, text: &str) -> Result<Option<JsMatch>, String> {
        let Some(c) = self.0.captures(text).map_err(|e| e.to_string())? else { return Ok(None) };
        let whole = c.get(0).expect("group 0");
        Ok(Some(JsMatch {
            index: index16(text, whole.start()),
            whole: utf16(whole.as_str()),
            groups: (1..c.len()).map(|i| c.get(i).map(|g| utf16(g.as_str()))).collect(),
            named: self
                .0
                .capture_names()
                .flatten()
                .map(|n| (n.to_owned(), c.name(n).map(|g| utf16(g.as_str()))))
                .collect(),
        }))
    }
}

pub fn all() -> Vec<Box<dyn Engine>> {
    vec![Box::new(RegressUcs2), Box::new(RegressUtf8), Box::new(FancyRegex), Box::new(RustRegex)]
}
