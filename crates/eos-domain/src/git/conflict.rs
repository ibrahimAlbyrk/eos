//! Merge conflicts: git's two-letter status of an unmerged file, and the markers
//! a content conflict leaves in the file.
//!
//! The conflicted working tree is the source of truth: markers are parsed into
//! hunks the dashboard resolves one by one (ours, theirs or edited by hand),
//! then the chosen content is put back together. Both run on this side so the
//! dashboard never parses markers itself.

use std::collections::HashMap;

use eos_contracts::{
    ConflictDocumentResponseStyle, ConflictKind, ConflictSegment, ConflictSegmentConflict, ConflictSegmentContext,
    HunkResolution, HunkResolutionV1Choice,
};

/// The status codes git gives a file that is in conflict. The conflict count
/// and the conflict list both ask here, so they cannot disagree.
pub fn is_unmerged_code(xy: &str) -> bool {
    matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

/// What kind of conflict a status code is. `Content` is resolved hunk by
/// hunk; the others are a keep-or-remove choice for the whole file.
pub fn classify_conflict(xy: &str) -> ConflictKind {
    match xy {
        "DU" => ConflictKind::OursDeleted,
        "UD" => ConflictKind::TheirsDeleted,
        "AU" => ConflictKind::OursAdded,
        "UA" => ConflictKind::TheirsAdded,
        "DD" => ConflictKind::BothDeleted,
        _ => ConflictKind::Content,
    }
}

/// A content conflict's file split into context and hunks. `style` is
/// `Merge`, `Diff3` (a base section was seen) or `Unparseable`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConflictDocument {
    pub segments: Vec<ConflictSegment>,
    pub style: ConflictDocumentResponseStyle,
    pub conflict_count: i64,
}

impl ConflictDocument {
    fn unparseable() -> Self {
        Self { segments: Vec::new(), style: ConflictDocumentResponseStyle::Unparseable, conflict_count: 0 }
    }
}

const OURS: &str = "<<<<<<<";
const BASE: &str = "|||||||";
const SEPARATOR: &str = "=======";
const THEIRS: &str = ">>>>>>>";

/// A marker line: exactly seven of the marker's character, then nothing or
/// (when the marker may carry one) a space and a label, and an optional `\r`.
/// A run of eight is content. As in the JavaScript pattern this replaces, a
/// label stops at `\r`, U+2028 and U+2029, so a line holding one is no marker.
fn is_marker(line: &str, run: &str, labeled: bool) -> bool {
    let Some(rest) = line.strip_prefix(run) else { return false };
    let rest = rest.strip_suffix('\r').unwrap_or(rest);
    rest.is_empty() || (labeled && rest.starts_with(' ') && !rest.contains(['\r', '\u{2028}', '\u{2029}']))
}

fn is_ours(line: &str) -> bool {
    is_marker(line, OURS, true)
}

fn is_base(line: &str) -> bool {
    is_marker(line, BASE, true)
}

/// The separator is matched bare, as git writes it, so a label-bearing
/// `=======` line in content never takes a hunk over.
fn is_separator(line: &str) -> bool {
    is_marker(line, SEPARATOR, false)
}

fn is_theirs(line: &str) -> bool {
    is_marker(line, THEIRS, true)
}

/// Splits a conflicted file into context and conflict segments, in order.
/// Marker lines are dropped and content lines kept as they are (a trailing
/// `\r` included), so [`assemble_resolution`] gives back the line endings and
/// the final newline. A malformed or nested marker run, or a file with no
/// hunk at all, is `Unparseable`: the caller falls back to a whole-file choice.
pub fn parse_conflict_markers(content: &str) -> ConflictDocument {
    let lines: Vec<&str> = content.split('\n').collect();
    let owned = |slice: &[&str]| slice.iter().map(|l| (*l).to_owned()).collect::<Vec<_>>();
    let mut segments = Vec::new();
    let mut context: Vec<String> = Vec::new();
    let mut style = ConflictDocumentResponseStyle::Merge;
    let mut id = 0_i64;
    let mut i = 0;

    while i < lines.len() {
        if !is_ours(lines[i]) {
            context.push(lines[i].to_owned());
            i += 1;
            continue;
        }
        i += 1;
        let start = i;
        while i < lines.len()
            && !is_base(lines[i])
            && !is_separator(lines[i])
            && !is_theirs(lines[i])
            && !is_ours(lines[i])
        {
            i += 1;
        }
        let ours = owned(&lines[start..i]);

        // diff3 and zdiff3 write the common ancestor between the two sides.
        let mut base = None;
        if i < lines.len() && is_base(lines[i]) {
            style = ConflictDocumentResponseStyle::Diff3;
            i += 1;
            let start = i;
            while i < lines.len() && !is_separator(lines[i]) && !is_theirs(lines[i]) && !is_ours(lines[i]) {
                i += 1;
            }
            base = Some(owned(&lines[start..i]));
        }

        if i >= lines.len() || !is_separator(lines[i]) {
            return ConflictDocument::unparseable();
        }
        i += 1;
        let start = i;
        while i < lines.len() && !is_theirs(lines[i]) && !is_separator(lines[i]) && !is_ours(lines[i]) {
            i += 1;
        }
        let theirs = owned(&lines[start..i]);
        if i >= lines.len() || !is_theirs(lines[i]) {
            return ConflictDocument::unparseable();
        }
        i += 1;

        if !context.is_empty() {
            segments.push(ConflictSegment::Context(ConflictSegmentContext { lines: std::mem::take(&mut context) }));
        }
        segments.push(ConflictSegment::Conflict(ConflictSegmentConflict { id, ours, base, theirs }));
        id += 1;
    }

    if !context.is_empty() {
        segments.push(ConflictSegment::Context(ConflictSegmentContext { lines: context }));
    }
    if id == 0 {
        return ConflictDocument::unparseable();
    }
    ConflictDocument { segments, style, conflict_count: id }
}

/// A resolved file and the hunks that had no resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assembled {
    pub content: String,
    pub unresolved: Vec<i64>,
}

/// The resolved file: context as it was, each hunk replaced by its chosen
/// side or the lines edited by hand. A hunk with no resolution is listed in
/// `unresolved` and left out; the caller writes nothing while any remain.
/// `resolutions` holds one per hunk id; for an id given twice the last counts.
pub fn assemble_resolution(doc: &ConflictDocument, resolutions: &[HunkResolution]) -> Assembled {
    let chosen: HashMap<i64, &HunkResolution> = resolutions.iter().map(|r| (resolution_id(r), r)).collect();
    let mut out: Vec<&str> = Vec::new();
    let mut unresolved = Vec::new();
    for segment in &doc.segments {
        let hunk = match segment {
            ConflictSegment::Context(context) => {
                out.extend(context.lines.iter().map(String::as_str));
                continue;
            }
            ConflictSegment::Conflict(hunk) => hunk,
        };
        let lines = match chosen.get(&hunk.id) {
            None => {
                unresolved.push(hunk.id);
                continue;
            }
            Some(HunkResolution::Manual(manual)) => &manual.manual,
            Some(HunkResolution::Choice(choice)) => match choice.choice {
                HunkResolutionV1Choice::Ours => &hunk.ours,
                HunkResolutionV1Choice::Theirs => &hunk.theirs,
            },
        };
        out.extend(lines.iter().map(String::as_str));
    }
    Assembled { content: out.join("\n"), unresolved }
}

fn resolution_id(resolution: &HunkResolution) -> i64 {
    match resolution {
        HunkResolution::Choice(choice) => choice.id,
        HunkResolution::Manual(manual) => manual.id,
    }
}

/// A cheap hash of a file's content (FNV-1a over UTF-16 code units, then the
/// length), both in hex: the resolve request echoes the one the document was
/// shown with, and the apply is refused when the file changed since.
pub fn fingerprint_of(content: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    let mut units: u64 = 0;
    for unit in content.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
        units += 1;
    }
    format!("{hash:x}:{units:x}")
}

#[cfg(test)]
mod tests {
    use eos_contracts::{HunkResolutionChoice, HunkResolutionManual};

    use super::*;

    const MERGE: &str = "a\n<<<<<<< HEAD\nY\n=======\nX\n>>>>>>> feat\nc\n";
    const DIFF3: &str = "a\n<<<<<<< HEAD\nY\n||||||| base\nZ\n=======\nX\n>>>>>>> feat\nc\n";
    const TWO: &str = "<<<<<<< A\n1\n=======\n2\n>>>>>>> B\nmid\n<<<<<<< A\n3\n=======\n4\n>>>>>>> B\n";

    fn context(lines: &[&str]) -> ConflictSegment {
        ConflictSegment::Context(ConflictSegmentContext { lines: lines.iter().map(|l| (*l).to_owned()).collect() })
    }

    fn hunk(id: i64, ours: &[&str], base: Option<&[&str]>, theirs: &[&str]) -> ConflictSegment {
        let own = |lines: &[&str]| lines.iter().map(|l| (*l).to_owned()).collect::<Vec<_>>();
        ConflictSegment::Conflict(ConflictSegmentConflict {
            id,
            ours: own(ours),
            base: base.map(own),
            theirs: own(theirs),
        })
    }

    fn choose(id: i64, choice: HunkResolutionV1Choice) -> HunkResolution {
        HunkResolution::Choice(HunkResolutionChoice { id, choice })
    }

    #[test]
    fn the_seven_unmerged_codes_and_no_other() {
        for xy in ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] {
            assert!(is_unmerged_code(xy), "{xy}");
        }
        for xy in [" M", "M ", "??", "A ", "R ", "", "U"] {
            assert!(!is_unmerged_code(xy), "{xy}");
        }
    }

    #[test]
    fn each_code_has_its_kind() {
        assert_eq!(classify_conflict("UU"), ConflictKind::Content);
        assert_eq!(classify_conflict("AA"), ConflictKind::Content);
        assert_eq!(classify_conflict("DU"), ConflictKind::OursDeleted);
        assert_eq!(classify_conflict("UD"), ConflictKind::TheirsDeleted);
        assert_eq!(classify_conflict("AU"), ConflictKind::OursAdded);
        assert_eq!(classify_conflict("UA"), ConflictKind::TheirsAdded);
        assert_eq!(classify_conflict("DD"), ConflictKind::BothDeleted);
    }

    #[test]
    fn merge_markers_split_into_context_and_a_hunk() {
        let doc = parse_conflict_markers(MERGE);
        assert_eq!(doc.style, ConflictDocumentResponseStyle::Merge);
        assert_eq!(doc.conflict_count, 1);
        assert_eq!(doc.segments, vec![context(&["a"]), hunk(0, &["Y"], None, &["X"]), context(&["c", ""])]);
    }

    #[test]
    fn a_diff3_hunk_keeps_its_base() {
        let doc = parse_conflict_markers(DIFF3);
        assert_eq!(doc.style, ConflictDocumentResponseStyle::Diff3);
        assert_eq!(doc.segments[1], hunk(0, &["Y"], Some(&["Z"]), &["X"]));
    }

    #[test]
    fn a_missing_separator_or_no_marker_is_unparseable() {
        let doc = parse_conflict_markers("a\n<<<<<<< HEAD\nY\n>>>>>>> feat\n");
        assert_eq!((doc.style, doc.conflict_count), (ConflictDocumentResponseStyle::Unparseable, 0));
        assert_eq!(parse_conflict_markers("just\nplain\ntext\n").style, ConflictDocumentResponseStyle::Unparseable);
    }

    #[test]
    fn crlf_line_endings_stay_in_the_lines() {
        let doc = parse_conflict_markers("a\r\n<<<<<<< HEAD\r\nY\r\n=======\r\nX\r\n>>>>>>> feat\r\nc\r\n");
        assert_eq!(doc.conflict_count, 1);
        assert_eq!(doc.segments[1], hunk(0, &["Y\r"], None, &["X\r"]));
    }

    #[test]
    fn hunks_are_numbered_in_order() {
        let doc = parse_conflict_markers(TWO);
        assert_eq!(doc.conflict_count, 2);
        let hunks: Vec<_> = doc.segments.into_iter().filter(|s| matches!(s, ConflictSegment::Conflict(_))).collect();
        assert_eq!(hunks, vec![hunk(0, &["1"], None, &["2"]), hunk(1, &["3"], None, &["4"])]);
    }

    // What the TypeScript parser makes of marker-like lines (frozen from it).
    #[test]
    fn marker_like_lines_read_as_the_typescript_reads_them() {
        let odd_label = parse_conflict_markers("<<<<<<< a\u{2028}\n1\n=======\n2\n>>>>>>> b\n");
        assert_eq!(odd_label.style, ConflictDocumentResponseStyle::Unparseable);
        let bare = parse_conflict_markers("<<<<<<<\r\n1\n=======\r\n2\n>>>>>>>\r\n");
        assert_eq!(bare.segments, vec![hunk(0, &["1"], None, &["2"]), context(&[""])]);
        let eight = parse_conflict_markers("<<<<<<<< x\n<<<<<<< x\n1\n=======\n2\n>>>>>>> y\n");
        assert_eq!(eight.segments, vec![context(&["<<<<<<<< x"]), hunk(0, &["1"], None, &["2"]), context(&[""])]);
        let labeled = parse_conflict_markers("<<<<<<< x\n1\n======= label\n2\n=======\n3\n>>>>>>> y");
        assert_eq!(labeled.segments, vec![hunk(0, &["1", "======= label", "2"], None, &["3"])]);
    }

    #[test]
    fn the_chosen_side_is_put_back_with_context_and_the_last_newline() {
        let doc = parse_conflict_markers(MERGE);
        let ours = assemble_resolution(&doc, &[choose(0, HunkResolutionV1Choice::Ours)]);
        assert_eq!(ours, Assembled { content: "a\nY\nc\n".into(), unresolved: vec![] });
        assert_eq!(assemble_resolution(&doc, &[choose(0, HunkResolutionV1Choice::Theirs)]).content, "a\nX\nc\n");
        let manual = HunkResolution::Manual(HunkResolutionManual { id: 0, manual: vec!["MERGED".into()] });
        assert_eq!(assemble_resolution(&doc, &[manual]).content, "a\nMERGED\nc\n");
    }

    #[test]
    fn hunks_without_a_resolution_are_reported_and_left_out() {
        let doc = parse_conflict_markers(TWO);
        assert_eq!(assemble_resolution(&doc, &[choose(0, HunkResolutionV1Choice::Ours)]).unresolved, vec![1]);
    }

    // Values from the TypeScript `fingerprintOf` (frozen from it).
    #[test]
    fn the_fingerprint_equals_the_typescript_one() {
        assert_eq!(fingerprint_of(""), "811c9dc5:0");
        assert_eq!(fingerprint_of("abc"), "1a47e90b:3");
        assert_eq!(fingerprint_of(MERGE), "a29e582b:2a");
        assert_eq!(fingerprint_of("héllo 😀 wörld\r\n"), "e3e1d532:10");
        assert_eq!(fingerprint_of(&"x".repeat(1000)), "7d18165:3e8");
        assert_ne!(fingerprint_of("abc"), fingerprint_of("abc "));
    }
}
