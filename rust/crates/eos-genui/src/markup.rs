//! The `ui` markup of a visual answer: XML-ish JSX that only references data.
//!
//! ```text
//! <Tag a="text" b='text' c={json} flag>children</Tag>   <Tag a="x"/>
//! ```
//!
//! Text children are inline markdown (kept as strings). `{…}` attribute values are
//! JSON (read forgivingly), never JS. `<Code>` is raw text up to `</Code>`. Never
//! fails: problems come back as `errors` with 1-based line/col.
//!
//! [`parse_markup`] reads a whole document; an element left open at the end is
//! closed implicitly (and reported). [`parse_partial`] reads a document that is
//! still being streamed and returns only what is settled: closed elements, plus an
//! open container that already holds a closed element (flagged `partial`); an
//! unfinished tag, an open leaf and trailing text are dropped.
//!
//! Lines, columns and offsets count UTF-16 code units, as the dashboard's parser
//! does. Nesting is not limited here (the validator rejects more than 8 levels);
//! nothing in this module recurses, so a hostile document cannot exhaust the stack.

use indexmap::IndexMap;

use crate::js::is_ws_unit;
use crate::partial_json::parse_loose_units;
use crate::utf16::{self, ascii, unit};
use crate::value::{Object, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MarkupPos {
    pub line: usize,
    pub col: usize,
    pub offset: usize,
}

#[derive(Debug, Default)]
pub struct MarkupElement {
    pub name: String,
    /// Quoted values are strings, `{…}` values parsed JSON, bare flags `true`.
    pub attrs: Object,
    /// Where each attribute starts, for error messages.
    pub attr_pos: IndexMap<String, MarkupPos>,
    pub children: Vec<MarkupNode>,
    /// The element's own text: its text children joined (inline markdown), or the
    /// raw code of a `<Code>` element. Empty when it has none.
    pub text: String,
    pub pos: MarkupPos,
    pub self_closing: bool,
    /// [`parse_partial`] only: still open, children so far are complete.
    pub partial: bool,
}

impl MarkupElement {
    pub fn attr(&self, name: &str) -> Option<&Value> {
        self.attrs.get(name)
    }

    pub fn element_children(&self) -> impl Iterator<Item = &MarkupElement> {
        self.children.iter().filter_map(MarkupNode::as_element)
    }
}

// A tree can be as deep as the document is long; the default drop would recurse.
impl Drop for MarkupElement {
    fn drop(&mut self) {
        let mut pending = std::mem::take(&mut self.children);
        while let Some(node) = pending.pop() {
            if let MarkupNode::Element(mut el) = node {
                pending.append(&mut el.children);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkupText {
    pub text: String,
    pub pos: MarkupPos,
}

// Most nodes are elements; boxing them would cost an allocation each to save
// space on the few text nodes.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum MarkupNode {
    Element(MarkupElement),
    Text(MarkupText),
}

impl MarkupNode {
    pub fn as_element(&self) -> Option<&MarkupElement> {
        match self {
            MarkupNode::Element(el) => Some(el),
            MarkupNode::Text(_) => None,
        }
    }

    fn is_text(&self) -> bool {
        matches!(self, MarkupNode::Text(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkupError {
    pub message: String,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Default)]
pub struct MarkupParse {
    pub nodes: Vec<MarkupNode>,
    pub errors: Vec<MarkupError>,
}

/// Elements whose content is raw text, never parsed for tags.
pub const RAW_TEXT_TAGS: &[&str] = &["Code"];

pub fn parse_markup(src: &str) -> MarkupParse {
    run(src, false)
}

pub fn parse_partial(prefix: &str) -> MarkupParse {
    run(prefix, true)
}

/// Depth-first visit of every element; depth 1 = top level.
pub fn walk_markup<'a>(
    nodes: &'a [MarkupNode],
    mut visit: impl FnMut(&'a MarkupElement, usize, Option<&'a MarkupElement>),
) {
    let mut pending: Vec<(&MarkupElement, usize, Option<&MarkupElement>)> =
        nodes.iter().rev().filter_map(MarkupNode::as_element).map(|el| (el, 1, None)).collect();
    while let Some((el, depth, parent)) = pending.pop() {
        visit(el, depth, parent);
        pending.extend(el.children.iter().rev().filter_map(MarkupNode::as_element).map(|c| (c, depth + 1, Some(el))));
    }
}

pub fn markup_depth(nodes: &[MarkupNode]) -> usize {
    let mut max = 0;
    walk_markup(nodes, |_, depth, _| max = max.max(depth));
    max
}

// `<Carousel of="places">` — the start tag with its identifying attributes, for
// messages the model can locate.
const KEY_ATTRS: &[&str] = &["of", "pick", "bind", "type", "title", "label", "expr"];

pub fn tag_label(el: &MarkupElement) -> String {
    let mut parts = vec![el.name.clone()];
    for k in KEY_ATTRS {
        if parts.len() > 2 {
            break;
        }
        if let Some(Value::String(v)) = el.attrs.get(k) {
            let shown = if crate::js::len16(v) > 24 { format!("{}…", crate::js::head16(v, 23)) } else { v.clone() };
            parts.push(format!("{k}=\"{shown}\""));
        }
    }
    format!("<{}>", parts.join(" "))
}

// ---- parser ------------------------------------------------------------------

struct Ctx<'a> {
    s: &'a [u16],
    i: usize,
    partial: bool,
    errors: Vec<MarkupError>,
    line_starts: Vec<usize>,
    root: Vec<MarkupNode>,
    // Open elements. Each joins its parent's children when it closes, which is
    // where it would sit had it been appended on open: nothing follows an open
    // element in its parent before it closes.
    stack: Vec<MarkupElement>,
}

fn run(input: &str, partial: bool) -> MarkupParse {
    let s = utf16::units(input);
    let mut ctx = Ctx {
        s: &s,
        i: 0,
        partial,
        errors: Vec::new(),
        line_starts: line_starts(&s),
        root: Vec::new(),
        stack: Vec::new(),
    };
    let len = s.len();
    let mut text_start = 0;
    while ctx.i < len {
        let Some(lt) = utf16::find_unit(&s, unit('<'), ctx.i) else {
            ctx.i = len;
            break;
        };
        let next = s.get(lt + 1).map_or(0, |u| ascii(*u));
        if utf16::starts_with(&s, lt, "<!--") {
            ctx.push_text(text_start, lt);
            let Some(close) = utf16::find(&s, "-->", lt + 4) else {
                if !partial {
                    ctx.err(lt, "comment is never closed (missing -->)".to_owned());
                }
                ctx.i = len;
                text_start = len;
                break;
            };
            ctx.i = close + 3;
            text_start = ctx.i;
            continue;
        }
        if next == b'/' && s.get(lt + 2).is_some_and(|u| ascii(*u).is_ascii_alphabetic()) {
            let Some(end) = utf16::find_unit(&s, unit('>'), lt) else {
                // `</Sta` at the end of a stream — the close is still being written.
                if !partial {
                    ctx.err(lt, "closing tag is never finished (missing >)".to_owned());
                }
                ctx.push_text(text_start, lt);
                ctx.i = len;
                text_start = len;
                break;
            };
            ctx.push_text(text_start, lt);
            let name = utf16::text(utf16::trim(&s[lt + 2..end]));
            ctx.close_tag(&name, lt);
            ctx.i = end + 1;
            text_start = ctx.i;
            continue;
        }
        if next.is_ascii_alphabetic() {
            let Some(mut el) = ctx.read_start_tag(lt) else {
                // Unfinished start tag at the end of the input.
                if !partial {
                    ctx.err(lt, "tag is never finished (missing > or />)".to_owned());
                }
                ctx.push_text(text_start, lt);
                ctx.i = len;
                text_start = len;
                break;
            };
            ctx.push_text(text_start, lt);
            if el.self_closing {
                ctx.append(MarkupNode::Element(el));
                text_start = ctx.i;
                continue;
            }
            if RAW_TEXT_TAGS.contains(&el.name.as_str()) {
                let raw_start = ctx.i;
                let Some(close_at) = utf16::find(&s, &format!("</{}", el.name), raw_start) else {
                    if !partial {
                        ctx.err(lt, format!("<{}> opened on line {} is never closed", el.name, el.pos.line));
                        set_raw(&mut el, &s[raw_start..], ctx.pos_at(raw_start));
                        ctx.append(MarkupNode::Element(el));
                    }
                    ctx.i = len;
                    text_start = len;
                    break;
                };
                let Some(gt) = utf16::find_unit(&s, unit('>'), close_at) else {
                    if !partial {
                        ctx.err(close_at, "closing tag is never finished (missing >)".to_owned());
                        set_raw(&mut el, &s[raw_start..close_at], ctx.pos_at(raw_start));
                        ctx.append(MarkupNode::Element(el));
                    }
                    ctx.i = len;
                    text_start = len;
                    break;
                };
                set_raw(&mut el, &s[raw_start..close_at], ctx.pos_at(raw_start));
                ctx.append(MarkupNode::Element(el));
                ctx.i = gt + 1;
                text_start = ctx.i;
                continue;
            }
            ctx.stack.push(el);
            text_start = ctx.i;
            continue;
        }
        // A literal "<" (e.g. "a < b") stays in the text.
        ctx.i = lt + 1;
    }
    ctx.finish(text_start);
    MarkupParse { nodes: ctx.root, errors: ctx.errors }
}

fn line_starts(s: &[u16]) -> Vec<usize> {
    let mut out = vec![0];
    out.extend(s.iter().enumerate().filter(|(_, u)| **u == 10).map(|(i, _)| i + 1));
    out
}

impl Ctx<'_> {
    fn pos_at(&self, offset: usize) -> MarkupPos {
        let line = self.line_starts.partition_point(|start| *start <= offset).max(1);
        MarkupPos { line, col: offset - self.line_starts[line - 1] + 1, offset }
    }

    fn err(&mut self, offset: usize, message: String) {
        let p = self.pos_at(offset);
        self.errors.push(MarkupError { message, line: p.line, col: p.col });
    }

    fn append(&mut self, node: MarkupNode) {
        match self.stack.last_mut() {
            Some(open) => open.children.push(node),
            None => self.root.push(node),
        }
    }

    fn push_text(&mut self, from: usize, to: usize) {
        if to <= from {
            return;
        }
        let Some(text) = normalize_text(&self.s[from..to]) else { return };
        let leading = self.s[from..to].iter().take_while(|u| is_ws_unit(**u)).count();
        let pos = self.pos_at(from + leading);
        self.append(MarkupNode::Text(MarkupText { text, pos }));
    }

    fn close_tag(&mut self, name: &str, at: usize) {
        let Some(top) = self.stack.last() else {
            self.err(at, format!("</{name}> has no matching open tag"));
            return;
        };
        let Some(idx) = self.stack.iter().rposition(|el| el.name == name) else {
            let message = format!("</{name}> has no matching open tag (open: <{}>)", top.name);
            self.err(at, message);
            return;
        };
        while self.stack.len() > idx + 1 {
            let Some(el) = self.stack.pop() else { break };
            self.err(el.pos.offset, format!("<{}> opened on line {} is closed by </{name}>", el.name, el.pos.line));
            self.close(el);
        }
        if let Some(el) = self.stack.pop() {
            self.close(el);
        }
    }

    fn close(&mut self, mut el: MarkupElement) {
        finalize_text(&mut el);
        self.append(MarkupNode::Element(el));
    }

    fn finish(&mut self, text_start: usize) {
        if !self.partial {
            self.push_text(text_start, self.s.len());
            while let Some(el) = self.stack.pop() {
                self.err(el.pos.offset, format!("<{}> opened on line {} is never closed", el.name, el.pos.line));
                self.close(el);
            }
            return;
        }
        // Streaming: trailing text may be cut mid-word — drop it. Open elements stay
        // only when they already hold a closed element; the innermost go first.
        while let Some(mut el) = self.stack.pop() {
            while el.children.last().is_some_and(MarkupNode::is_text) {
                el.children.pop();
            }
            if !el.children.is_empty() {
                el.partial = true;
                self.close(el);
            }
        }
    }

    // Reads `<Name attrs… >` or `/>` starting at `lt`; None when the input ends first.
    fn read_start_tag(&mut self, lt: usize) -> Option<MarkupElement> {
        let s = self.s;
        let len = s.len();
        let mut i = lt + 1;
        let name_start = i;
        while i < len && is_name_unit(s[i]) {
            i += 1;
        }
        if i >= len {
            return None;
        }
        let mut el = MarkupElement::default();
        el.name = utf16::text(&s[name_start..i]);
        el.pos = self.pos_at(lt);
        loop {
            while i < len && is_ws_unit(s[i]) {
                i += 1;
            }
            if i >= len {
                return None;
            }
            let c = s[i];
            if c == unit('>') {
                self.i = i + 1;
                return Some(el);
            }
            if c == unit('/') {
                if i + 1 >= len {
                    return None;
                }
                if s[i + 1] == unit('>') {
                    el.self_closing = true;
                    self.i = i + 2;
                    return Some(el);
                }
                self.err(i, format!("unexpected \"/\" in <{}>", el.name));
                i += 1;
                continue;
            }
            if !is_attr_start(c) {
                // A stray character (a quote, a brace) — report it and move on so one slip
                // doesn't swallow the rest of the document.
                self.err(i, format!("unexpected \"{}\" in <{}>", utf16::text(&[c]), el.name));
                i += 1;
                continue;
            }
            let attr_start = i;
            while i < len && is_attr_unit(s[i]) {
                i += 1;
            }
            if i >= len {
                return None;
            }
            let name = utf16::text(&s[attr_start..i]);
            let apos = self.pos_at(attr_start);
            let mut j = i;
            while j < len && (s[j] == unit(' ') || s[j] == unit('\t')) {
                j += 1;
            }
            if j >= len {
                return None;
            }
            if s[j] != unit('=') {
                self.set_attr(&mut el, name, Value::Bool(true), apos);
                continue;
            }
            j += 1;
            while j < len && is_ws_unit(s[j]) {
                j += 1;
            }
            if j >= len {
                return None;
            }
            let q = s[j];
            if q == unit('"') || q == unit('\'') {
                let Some(end) = find_quote(s, j + 1, q) else {
                    if self.partial {
                        return None;
                    }
                    self.err(j, format!("attribute {name} is missing its closing {}", utf16::text(&[q])));
                    self.set_attr(&mut el, name, Value::String(quoted_value(&s[j + 1..], q)), apos);
                    self.i = len;
                    return None;
                };
                self.set_attr(&mut el, name, Value::String(quoted_value(&s[j + 1..end], q)), apos);
                i = end + 1;
                continue;
            }
            if q == unit('{') {
                let end = find_brace(s, j)?;
                let body = utf16::trim(&s[j + 1..end]);
                match parse_loose_units(body) {
                    Ok(value) => self.set_attr(&mut el, name, value, apos),
                    Err(e) => {
                        self.err(
                            j,
                            format!("attribute {name}={{…}} is not valid JSON ({}); {{…}} holds JSON only, use quotes for text", e.message),
                        );
                        self.set_attr(&mut el, name, Value::String(utf16::text(body)), apos);
                    }
                }
                i = end + 1;
                continue;
            }
            // Unquoted value: up to whitespace or the end of the tag.
            let mut k = j;
            while k < len && !is_ws_unit(s[k]) && s[k] != unit('>') && !(s[k] == unit('/') && utf16::is(s, k + 1, '>'))
            {
                k += 1;
            }
            if k >= len {
                return None;
            }
            self.set_attr(&mut el, name, Value::String(decode_entities(&utf16::text(&s[j..k]))), apos);
            i = k;
        }
    }

    fn set_attr(&mut self, el: &mut MarkupElement, name: String, value: Value, pos: MarkupPos) {
        if el.attrs.contains_key(&name) {
            self.errors.push(MarkupError {
                message: format!("<{}> repeats attribute {name}", el.name),
                line: pos.line,
                col: pos.col,
            });
        }
        el.attr_pos.insert(name.clone(), pos);
        el.attrs.insert(name, value);
    }
}

fn is_name_unit(u: u16) -> bool {
    let c = ascii(u);
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-')
}

fn is_attr_start(u: u16) -> bool {
    let c = ascii(u);
    c.is_ascii_alphabetic() || matches!(c, b'_' | b':' | b'@')
}

fn is_attr_unit(u: u16) -> bool {
    let c = ascii(u);
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b':' | b'.' | b'@' | b'-')
}

fn finalize_text(el: &mut MarkupElement) {
    if RAW_TEXT_TAGS.contains(&el.name.as_str()) {
        return;
    }
    let mut text = String::new();
    let mut first = true;
    for child in &el.children {
        if let MarkupNode::Text(t) = child {
            if !first {
                text.push('\n');
            }
            first = false;
            text.push_str(&t.text);
        }
    }
    el.text = text;
}

fn set_raw(el: &mut MarkupElement, raw: &[u16], pos: MarkupPos) {
    let code = utf16::text(&dedent(utf16::trim_end(strip_opening_newline(raw)), true));
    el.children =
        if code.is_empty() { Vec::new() } else { vec![MarkupNode::Text(MarkupText { text: code.clone(), pos })] };
    el.text = code;
}

// /^[ \t]*\r?\n/
fn strip_opening_newline(raw: &[u16]) -> &[u16] {
    let mut i = raw.iter().take_while(|u| **u == unit(' ') || **u == unit('\t')).count();
    if utf16::is(raw, i, '\r') {
        i += 1;
    }
    if utf16::is(raw, i, '\n') { &raw[i + 1..] } else { raw }
}

// Dedent, trim blank edges; internal newlines are kept (markdown paragraphs).
fn normalize_text(raw: &[u16]) -> Option<String> {
    if utf16::is_blank(raw) {
        return None;
    }
    Some(utf16::text(utf16::trim(&dedent(raw, false))))
}

fn indent(line: &[u16]) -> usize {
    line.iter().take_while(|u| **u == unit(' ') || **u == unit('\t')).count()
}

// The first line follows the tag on the same line, so it sets no indent — unless
// it starts the block (raw code after its opening newline).
fn dedent(raw: &[u16], include_first: bool) -> Vec<u16> {
    let skip = usize::from(!include_first);
    let min = raw.split(|u| *u == unit('\n')).skip(skip).filter(|l| !utf16::is_blank(l)).map(indent).min();
    let Some(min) = min.filter(|m| *m > 0) else { return raw.to_vec() };
    let mut out = Vec::with_capacity(raw.len());
    for (k, line) in raw.split(|u| *u == unit('\n')).enumerate() {
        if k > 0 {
            out.push(unit('\n'));
        }
        let cut = if k == 0 && !include_first { 0 } else { min.min(indent(line)) };
        out.extend_from_slice(&line[cut..]);
    }
    out
}

// The value between quotes: `\"` reads as the quote (models sometimes write it),
// then entities are decoded.
fn quoted_value(raw: &[u16], q: u16) -> String {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == unit('\\') && raw.get(i + 1) == Some(&q) {
            i += 1;
        }
        out.push(raw[i]);
        i += 1;
    }
    decode_entities(&utf16::text(&out))
}

// The closing quote, skipping backslash-escaped ones.
fn find_quote(s: &[u16], from: usize, q: u16) -> Option<usize> {
    let mut i = from;
    while i < s.len() {
        if s[i] == unit('\\') && s.get(i + 1) == Some(&q) {
            i += 2;
            continue;
        }
        if s[i] == q {
            return Some(i);
        }
        i += 1;
    }
    None
}

// The `}` that closes the `{` at `open`, skipping strings and nested brackets.
fn find_brace(s: &[u16], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open;
    while i < s.len() {
        let c = s[i];
        if c == unit('"') || c == unit('\'') {
            let mut k = i + 1;
            while k < s.len() && s[k] != c {
                k += if s[k] == unit('\\') { 2 } else { 1 };
            }
            if k >= s.len() {
                return None;
            }
            i = k + 1;
            continue;
        }
        if c == unit('{') || c == unit('[') {
            depth += 1;
        } else if c == unit('}') || c == unit(']') {
            depth -= 1;
            if depth == 0 {
                return (c == unit('}')).then_some(i);
            }
        }
        i += 1;
    }
    None
}

const ENTITIES: &[(&str, char)] =
    &[("quot;", '"'), ("apos;", '\''), ("#39;", '\''), ("lt;", '<'), ("gt;", '>'), ("amp;", '&')];

fn decode_entities(v: &str) -> String {
    if !v.contains('&') {
        return v.to_owned();
    }
    let mut out = String::with_capacity(v.len());
    let mut rest = v;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        match ENTITIES.iter().find(|(name, _)| tail.starts_with(name)) {
            Some((name, c)) => {
                out.push(*c);
                rest = &tail[name.len()..];
            }
            None => {
                out.push('&');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(node: &MarkupNode) -> &MarkupElement {
        node.as_element().expect("an element")
    }

    #[test]
    fn reads_attributes_and_children() {
        let r = parse_markup("<Section title=\"A &amp; B\" n={3} flag>\n  <Text>hi</Text>\n</Section>");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let section = el(&r.nodes[0]);
        assert_eq!(section.attr("title"), Some(&Value::from("A & B")));
        assert_eq!(section.attr("n"), Some(&Value::Number(3.0)));
        assert_eq!(section.attr("flag"), Some(&Value::Bool(true)));
        assert_eq!(el(&section.children[0]).text, "hi");
        assert_eq!(el(&section.children[0]).pos, MarkupPos { line: 2, col: 3, offset: 41 });
        assert_eq!(tag_label(section), "<Section title=\"A & B\">");
    }

    #[test]
    fn an_open_element_is_closed_and_reported() {
        let r = parse_markup("<Stack>\n<Text>x</Text>");
        assert_eq!(
            r.errors,
            [MarkupError { message: "<Stack> opened on line 1 is never closed".to_owned(), line: 1, col: 1 }]
        );
        assert_eq!(markup_depth(&r.nodes), 2);
    }

    #[test]
    fn a_stream_keeps_only_what_is_settled() {
        let r = parse_partial("<Stack><Text>a</Text><Text>b");
        let stack = el(&r.nodes[0]);
        assert!(stack.partial);
        assert_eq!(stack.children.len(), 1);
        assert!(parse_partial("<Stack><Text>a").nodes.is_empty());
    }

    #[test]
    fn deep_nesting_neither_overflows_nor_leaks_the_stack() {
        let doc = "<a>".repeat(200_000);
        let r = parse_markup(&doc);
        assert_eq!(r.errors.len(), 200_000);
        assert_eq!(markup_depth(&r.nodes), 200_000);
    }
}
