//! `foldFlowLines.js`: keeps text at up to 80 columns by turning spaces into
//! line breaks.

use super::{NL, SP, TAB, Units, push_spaces};

pub(crate) const LINE_WIDTH: isize = 80;
const MIN_CONTENT_WIDTH: isize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Flow,
    Block,
    Quoted,
}

fn at(text: &[u16], i: isize) -> Option<u16> {
    usize::try_from(i).ok().and_then(|i| text.get(i).copied())
}

fn is_blank(ch: Option<u16>) -> bool {
    matches!(ch, Some(SP | NL | TAB))
}

/// Presumes `i + 1` is at the start of a line; returns the index of the last
/// line feed of a more-indented block.
fn consume_more_indented_lines(text: &[u16], mut i: isize, indent: isize) -> isize {
    let mut end = i;
    let mut start = i + 1;
    let mut ch = at(text, start);
    while matches!(ch, Some(SP | TAB)) {
        if i < start + indent {
            i += 1;
            ch = at(text, i);
        } else {
            loop {
                i += 1;
                ch = at(text, i);
                if ch.is_none() || ch == Some(NL) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = at(text, start);
        }
    }
    end
}

/// Folds `text`; continuation lines start with `indent` spaces. `overflow` is
/// set when a line could not be kept inside the width.
pub(crate) fn fold_flow_lines(
    text: Units,
    indent: usize,
    mode: Mode,
    indent_at_start: Option<usize>,
    overflow: &mut bool,
) -> Units {
    let indent_len = indent as isize;
    let len = text.len() as isize;
    let end_step = (1 + MIN_CONTENT_WIDTH).max(1 + LINE_WIDTH - indent_len);
    if len <= end_step {
        return text;
    }
    let mut folds: Vec<isize> = Vec::new();
    let mut escaped_folds: Vec<isize> = Vec::new();
    let mut end = LINE_WIDTH - indent_len;
    if let Some(at_start) = indent_at_start {
        let at_start = at_start as isize;
        if at_start > LINE_WIDTH - MIN_CONTENT_WIDTH.max(2) {
            folds.push(0);
        } else {
            end = LINE_WIDTH - at_start;
        }
    }
    let mut split: Option<isize> = None;
    let mut prev: Option<u16> = None;
    let mut over = false;
    let mut i: isize = -1;
    let mut esc_start: isize = -1;
    let mut esc_end: isize = -1;
    if mode == Mode::Block {
        i = consume_more_indented_lines(&text, i, indent_len);
        if i != -1 {
            end = i + end_step;
        }
    }
    loop {
        i += 1;
        let Some(first) = at(&text, i) else { break };
        let mut ch = Some(first);
        if mode == Mode::Quoted && first == u16::from(b'\\') {
            esc_start = i;
            i += match at(&text, i + 1) {
                Some(c) if c == u16::from(b'x') => 3,
                Some(c) if c == u16::from(b'u') => 5,
                Some(c) if c == u16::from(b'U') => 9,
                _ => 1,
            };
            esc_end = i;
        }
        if first == NL {
            if mode == Mode::Block {
                i = consume_more_indented_lines(&text, i, indent_len);
            }
            end = i + indent_len + end_step;
            split = None;
        } else {
            // A space between two non-spaces can become a line break.
            if first == SP && prev.is_some() && !is_blank(prev) {
                let next = at(&text, i + 1);
                if next.is_some() && !is_blank(next) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(s) = split {
                    folds.push(s);
                    end = s + end_step;
                    split = None;
                } else if mode == Mode::Quoted {
                    // White space collected at the end may stretch past the width.
                    while matches!(prev, Some(SP | TAB)) {
                        prev = ch;
                        i += 1;
                        ch = at(&text, i);
                        over = true;
                    }
                    // Account for the line-feed escape, without breaking an escape before it.
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    // Bail out when the width is shorter than an escape (or there is no room at all).
                    if j < 0 || escaped_folds.contains(&j) {
                        return text;
                    }
                    folds.push(j);
                    escaped_folds.push(j);
                    end = j + end_step;
                    split = None;
                } else {
                    over = true;
                }
            }
        }
        prev = ch;
    }
    if over {
        *overflow = true;
    }
    if folds.is_empty() {
        return text;
    }
    let slice = |from: isize, to: isize| -> &[u16] {
        let (from, to) = (from.clamp(0, len) as usize, to.clamp(0, len) as usize);
        if from < to { &text[from..to] } else { &[] }
    };
    let mut out: Units = slice(0, folds[0]).to_vec();
    for (n, &fold) in folds.iter().enumerate() {
        let to = folds.get(n + 1).copied().filter(|f| *f != 0).unwrap_or(len);
        if fold == 0 {
            out.clear();
            out.push(NL);
            push_spaces(&mut out, indent);
            out.extend_from_slice(slice(0, to));
        } else {
            if mode == Mode::Quoted
                && escaped_folds.contains(&fold)
                && let Some(ch) = at(&text, fold)
            {
                out.push(ch);
                out.push(u16::from(b'\\'));
            }
            out.push(NL);
            push_spaces(&mut out, indent);
            out.extend_from_slice(slice(fold + 1, to));
        }
    }
    out
}
