//! `stringifyString.js`: which of plain, quoted and block style a string gets.

use std::sync::LazyLock;

use regress::Regex;

use super::fold::{LINE_WIDTH, Mode, fold_flow_lines};
use super::{Ctx, NL, SP, TAB, Units, push_spaces, push_str, units};

const DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH: usize = 40;
const QUOTE: u16 = b'"' as u16;
const APOSTROPHE: u16 = b'\'' as u16;
const BACKSLASH: u16 = b'\\' as u16;

fn regex(source: &str) -> Regex {
    // The sources are literals from the original; a typo here fails every test.
    Regex::new(source).unwrap_or_else(|e| panic!("bad regex {source}: {e}"))
}

fn matches(re: &Regex, text: &[u16]) -> bool {
    re.find_from_ucs2(text, 0).next().is_some()
}

/// What plain style cannot hold: an indicator at the start, `: ` or ` #`
/// inside, white space around a line feed, a trailing space or colon.
static NOT_PLAIN: LazyLock<Regex> =
    LazyLock::new(|| regex(r##"^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"##));
static SPACE_AROUND_LINE_FEED: LazyLock<Regex> = LazyLock::new(|| regex(r"[ \t]\n|\n[ \t]"));
static ENDS_IN_INDENTED_BLANK: LazyLock<Regex> = LazyLock::new(|| regex(r"\n[\t ]+$"));
static BLOCK_END_NEWLINES: LazyLock<Regex> = LazyLock::new(|| regex(r"(^|(?<!\n))\n+(?!\n|$)"));
static MORE_INDENTED: LazyLock<Regex> = LazyLock::new(|| regex(r"(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?"));

/// Plain text the core schema would read back as something other than a
/// string: null, a boolean, an integer, a float.
static OTHER_TYPES: LazyLock<[Regex; 7]> = LazyLock::new(|| {
    [
        regex(r"^(?:~|[Nn]ull|NULL)?$"),
        regex(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$"),
        regex(r"^0o[0-7]+$"),
        regex(r"^[-+]?[0-9]+$"),
        regex(r"^0x[0-9a-fA-F]+$"),
        regex(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$"),
        regex(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$"),
    ]
});
static FLOAT: LazyLock<Regex> = LazyLock::new(|| regex(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$"));

/// `text.replace(re, …)` with the `g` flag: `with` writes what replaces each match.
fn replace_all(re: &Regex, text: &[u16], mut with: impl FnMut(&regress::Match, &mut Units)) -> Units {
    let mut out = Units::with_capacity(text.len());
    let mut last = 0;
    for m in re.find_from_ucs2(text, 0) {
        out.extend_from_slice(&text[last..m.range().start]);
        with(&m, &mut out);
        last = m.range().end;
    }
    out.extend_from_slice(&text[last..]);
    out
}

/// `text.replace(/\n+/g, "$&" + insert)`: `insert` after every run of line feeds.
fn after_line_feed_runs(text: &[u16], insert: &[u16]) -> Units {
    let mut out = Units::with_capacity(text.len());
    for (i, &ch) in text.iter().enumerate() {
        out.push(ch);
        if ch == NL && text.get(i + 1) != Some(&NL) {
            out.extend_from_slice(insert);
        }
    }
    out
}

fn line_feed_and_indent(indent: usize) -> Units {
    let mut s = vec![NL];
    push_spaces(&mut s, indent);
    s
}

fn spaces(indent: usize) -> Units {
    vec![SP; indent]
}

/// A line starting with `%`, `---` or `...` would be read as a directive or a document marker.
fn contains_document_marker(text: &[u16]) -> bool {
    let line_start = |i: usize| i == 0 || matches!(text[i - 1], 0x0a | 0x0d | 0x2028 | 0x2029);
    let starts = |i: usize, word: &str| text[i..].iter().copied().take(word.len()).eq(word.bytes().map(u16::from));
    (0..text.len()).any(|i| line_start(i) && (starts(i, "%") || starts(i, "---") || starts(i, "...")))
}

fn line_length_over_limit(text: &[u16], indent: usize) -> bool {
    let limit = LINE_WIDTH - indent as isize;
    let len = text.len() as isize;
    if len <= limit {
        return false;
    }
    let mut start: isize = 0;
    for (i, &ch) in text.iter().enumerate() {
        if ch == NL {
            let i = i as isize;
            if i - start > limit {
                return true;
            }
            start = i + 1;
            if len - start <= limit {
                return false;
            }
        }
    }
    true
}

/// `JSON.stringify` of a string.
fn json_string(value: &[u16]) -> Units {
    let mut out = Units::with_capacity(value.len() + 2);
    out.push(QUOTE);
    for &ch in value {
        match ch {
            0x22 => push_str(&mut out, "\\\""),
            0x5c => push_str(&mut out, "\\\\"),
            0x08 => push_str(&mut out, "\\b"),
            0x0c => push_str(&mut out, "\\f"),
            0x0a => push_str(&mut out, "\\n"),
            0x0d => push_str(&mut out, "\\r"),
            0x09 => push_str(&mut out, "\\t"),
            c if c < 0x20 => push_str(&mut out, &format!("\\u{c:04x}")),
            c => out.push(c),
        }
    }
    out.push(QUOTE);
    out
}

fn double_quoted(value: &[u16], ctx: &Ctx) -> Units {
    let json = json_string(value);
    let at = |i: usize| json.get(i).copied();
    let is = |i: usize, c: u8| at(i) == Some(u16::from(c));
    let indent = if ctx.indent > 0 {
        ctx.indent
    } else if contains_document_marker(value) {
        2
    } else {
        0
    };
    let mut out = Units::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while let Some(mut ch) = at(i) {
        if ch == SP && is(i + 1, b'\\') && is(i + 2, b'n') {
            // A space before a line feed is escaped so folding cannot eat it.
            out.extend_from_slice(&json[start..i]);
            push_str(&mut out, "\\ ");
            i += 1;
            start = i;
            ch = BACKSLASH;
        }
        if ch == BACKSLASH {
            match at(i + 1) {
                Some(c) if c == u16::from(b'u') => {
                    out.extend_from_slice(&json[start..i]);
                    let code = String::from_utf16_lossy(&json[(i + 2).min(json.len())..(i + 6).min(json.len())]);
                    match code.as_str() {
                        "0000" => push_str(&mut out, "\\0"),
                        "0007" => push_str(&mut out, "\\a"),
                        "000b" => push_str(&mut out, "\\v"),
                        "001b" => push_str(&mut out, "\\e"),
                        "0085" => push_str(&mut out, "\\N"),
                        "00a0" => push_str(&mut out, "\\_"),
                        "2028" => push_str(&mut out, "\\L"),
                        "2029" => push_str(&mut out, "\\P"),
                        code if code.starts_with("00") => push_str(&mut out, &format!("\\x{}", &code[2..])),
                        _ => out.extend_from_slice(&json[i..(i + 6).min(json.len())]),
                    }
                    i += 5;
                    start = i + 1;
                }
                Some(c) if c == u16::from(b'n') => {
                    if ctx.implicit_key || is(i + 2, b'"') || json.len() < DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH {
                        i += 1;
                    } else {
                        // Folding will eat the first line feed.
                        out.extend_from_slice(&json[start..i]);
                        push_str(&mut out, "\n\n");
                        while is(i + 2, b'\\') && is(i + 3, b'n') && !is(i + 4, b'"') {
                            out.push(NL);
                            i += 2;
                        }
                        push_spaces(&mut out, indent);
                        // A space after a line feed is escaped so folding cannot eat it.
                        if is(i + 2, b' ') {
                            out.push(BACKSLASH);
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let text = if start > 0 {
        out.extend_from_slice(&json[start.min(json.len())..]);
        out
    } else {
        json
    };
    if ctx.implicit_key { text } else { fold_flow_lines(text, indent, Mode::Quoted, ctx.indent_at_start, &mut false) }
}

fn single_quoted(value: &[u16], ctx: &Ctx) -> Units {
    if (ctx.implicit_key && value.contains(&NL)) || matches(&SPACE_AROUND_LINE_FEED, value) {
        return double_quoted(value, ctx);
    }
    let indent = if ctx.indent > 0 {
        ctx.indent
    } else if contains_document_marker(value) {
        2
    } else {
        0
    };
    let mut doubled = Units::with_capacity(value.len() + 2);
    for &ch in value {
        doubled.push(ch);
        if ch == APOSTROPHE {
            doubled.push(APOSTROPHE);
        }
    }
    let mut text = vec![APOSTROPHE];
    text.extend(after_line_feed_runs(&doubled, &line_feed_and_indent(indent)));
    text.push(APOSTROPHE);
    if ctx.implicit_key { text } else { fold_flow_lines(text, indent, Mode::Flow, ctx.indent_at_start, &mut false) }
}

fn quoted(value: &[u16], ctx: &Ctx) -> Units {
    let has_double = value.contains(&QUOTE);
    let has_single = value.contains(&APOSTROPHE);
    if has_double && !has_single { single_quoted(value, ctx) } else { double_quoted(value, ctx) }
}

fn block(value: &[u16], ctx: &Ctx, chomp_keep: &mut bool) -> Units {
    // A block cannot end in white space unless its last line is non-empty.
    if matches(&ENDS_IN_INDENTED_BLANK, value) {
        return quoted(value, ctx);
    }
    let indent = if ctx.indent > 0 {
        ctx.indent
    } else if ctx.force_block_indent || contains_document_marker(value) {
        2
    } else {
        0
    };
    let literal = !line_length_over_limit(value, indent);
    if value.is_empty() {
        return units(if literal { "|\n" } else { ">\n" });
    }

    // Chomping, from the white space at the end.
    let is_trailing = |ch: u16| ch == NL || ch == TAB || ch == SP;
    let end_start = value.iter().rposition(|ch| !is_trailing(*ch)).map_or(0, |i| i + 1);
    let mut end: Units = value[end_start..].to_vec();
    let chomp = match end.iter().position(|ch| *ch == NL) {
        None => "-",
        Some(first_nl) if end.len() == value.len() || first_nl != end.len() - 1 => {
            *chomp_keep = true;
            "+"
        }
        Some(_) => "",
    };
    let mut value = &value[..end_start];
    if !end.is_empty() {
        if end.last() == Some(&NL) {
            end.pop();
        }
        let pad = spaces(indent);
        end = replace_all(&BLOCK_END_NEWLINES, &end, |m, out| {
            out.extend_from_slice(&end[m.range()]);
            out.extend_from_slice(&pad);
        });
    }

    // The indentation indicator, from the white space at the start.
    let mut start_with_space = false;
    let mut start_nl_pos: Option<usize> = None;
    for (i, &ch) in value.iter().enumerate() {
        if ch == SP {
            start_with_space = true;
        } else if ch == NL {
            start_nl_pos = Some(i);
        } else {
            break;
        }
    }
    let lead = start_nl_pos.map_or(0, |i| i + 1);
    let start = after_line_feed_runs(&value[..lead], &spaces(indent));
    value = &value[lead..];

    let mut header = String::new();
    if start_with_space {
        header.push(if indent > 0 { '2' } else { '1' });
    }
    header.push_str(chomp);

    if !literal {
        // Fold, leaving more-indented lines alone.
        let mut doubled = Units::with_capacity(value.len());
        for (i, &ch) in value.iter().enumerate() {
            if ch == NL && (i == 0 || value[i - 1] != NL) {
                doubled.push(NL);
            }
            doubled.push(ch);
        }
        let kept = replace_all(&MORE_INDENTED, &doubled, |m, out| {
            for group in [m.group(1), m.group(2)].into_iter().flatten() {
                out.extend_from_slice(&doubled[group]);
            }
        });
        let mut text = start.clone();
        text.extend(after_line_feed_runs(&kept, &spaces(indent)));
        text.extend_from_slice(&end);
        let mut literal_fallback = false;
        let body = fold_flow_lines(text, indent, Mode::Block, Some(ctx.indent), &mut literal_fallback);
        if !literal_fallback {
            let mut out = units(&format!(">{header}\n"));
            push_spaces(&mut out, indent);
            out.extend(body);
            return out;
        }
    }
    let mut out = units(&format!("|{header}\n"));
    push_spaces(&mut out, indent);
    out.extend(start);
    out.extend(after_line_feed_runs(value, &spaces(indent)));
    out.extend(end);
    out
}

fn plain(value: &[u16], ctx: &Ctx, chomp_keep: &mut bool) -> Units {
    let multi_line = value.contains(&NL);
    if ctx.implicit_key && multi_line {
        return quoted(value, ctx);
    }
    if matches(&NOT_PLAIN, value) {
        return if ctx.implicit_key || !multi_line { quoted(value, ctx) } else { block(value, ctx, chomp_keep) };
    }
    // Where allowed, multi-line strings go in block style.
    if !ctx.implicit_key && multi_line {
        return block(value, ctx, chomp_keep);
    }
    if contains_document_marker(value) {
        if ctx.indent == 0 {
            return block(value, &Ctx { force_block_indent: true, ..ctx.clone() }, chomp_keep);
        } else if ctx.implicit_key && ctx.indent == 2 {
            return quoted(value, ctx);
        }
    }
    // The output must read back as a string: "42", "true" and "null" are quoted.
    if OTHER_TYPES.iter().any(|re| matches(re, value)) || matches(&FLOAT, value) {
        return quoted(value, ctx);
    }
    if ctx.implicit_key {
        value.to_vec()
    } else {
        fold_flow_lines(value.to_vec(), ctx.indent, Mode::Flow, ctx.indent_at_start, &mut false)
    }
}

pub(super) fn stringify(value: &[u16], ctx: &Ctx, chomp_keep: &mut bool) -> Units {
    // Control characters force double quotes.
    let control = |ch: &u16| matches!(*ch, 0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f);
    if value.iter().any(control) { double_quoted(value, ctx) } else { plain(value, ctx, chomp_keep) }
}
