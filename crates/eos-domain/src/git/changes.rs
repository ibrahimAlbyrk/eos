//! Reading git's machine output into the list of changed files, and cutting
//! one whole-tree patch into per-file patches.
//!
//! `git status --porcelain=v1 -z`, `git diff --numstat -z` and
//! `git diff --name-status -z` are NUL-separated token streams in which a
//! rename takes extra tokens, so they are walked token by token.

use std::collections::{HashMap, HashSet};

use eos_contracts::{ChangedFile, ChangedFileStatus};

use crate::text::locale_compare;

/// The cap on one file's patch, embedded or asked for on its own.
pub const PATCH_MAX_BYTES: usize = 256 * 1024;
/// The cap on all patches embedded in one changes answer.
pub const PATCHES_TOTAL_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Worktrees Eos keeps inside a repository live under this folder; they are
/// never the user's changes.
const MANAGED_PREFIX: &str = ".eos/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PorcelainEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub x: char,
    pub y: char,
}

impl PorcelainEntry {
    pub fn xy(&self) -> String {
        [self.x, self.y].iter().collect()
    }
}

/// `git status --porcelain=v1 -z`: `XY <path>`, and for a rename or copy one
/// more token, the original path.
pub fn parse_porcelain_z(out: &str) -> Vec<PorcelainEntry> {
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        let mut chars = token.chars();
        let (Some(x), Some(y), Some(' ')) = (chars.next(), chars.next(), chars.next()) else { continue };
        let path = chars.as_str();
        if path.is_empty() {
            continue;
        }
        let old_path = if x == 'R' || x == 'C' { tokens.next().map(str::to_owned) } else { None };
        entries.push(PorcelainEntry { path: path.to_owned(), old_path, x, y });
    }
    entries
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatEntry {
    pub path: String,
    pub old_path: Option<String>,
    /// `None` for a binary file.
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
}

fn count(field: &str) -> Option<Option<i64>> {
    if field == "-" {
        Some(None)
    } else if !field.is_empty() && field.bytes().all(|b| b.is_ascii_digit()) {
        Some(Some(field.parse().unwrap_or(i64::MAX)))
    } else {
        None
    }
}

/// `git diff --numstat -z`: `ins\tdel\tpath`; a rename has an empty path and
/// two more tokens, the old path and the new one. Binary files count `-`.
pub fn parse_numstat_z(out: &str) -> Vec<NumstatEntry> {
    let mut tokens = out.split('\0');
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        let mut fields = token.splitn(3, '\t');
        let (Some(ins), Some(del), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let (Some(insertions), Some(deletions)) = (count(ins), count(del)) else { continue };
        if path.contains('\n') {
            continue;
        }
        if path.is_empty() {
            let old_path = tokens.next();
            let Some(path) = tokens.next() else { break };
            entries.push(NumstatEntry {
                path: path.to_owned(),
                old_path: old_path.map(str::to_owned),
                insertions,
                deletions,
            });
        } else {
            entries.push(NumstatEntry { path: path.to_owned(), old_path: None, insertions, deletions });
        }
    }
    entries
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameStatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ChangedFileStatus,
}

/// `git diff --name-status -z`: a status letter then a path; `R###` and
/// `C###` are followed by two paths (old, new). A type change reads as
/// modified, a copy as added with its source as the old path.
pub fn parse_name_status_z(out: &str) -> Vec<NameStatusEntry> {
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    let mut entries = Vec::new();
    while let Some(code) = tokens.next() {
        let letter = code.chars().next().unwrap_or(' ');
        match letter {
            'R' | 'C' => {
                let old_path = tokens.next();
                let Some(path) = tokens.next() else { break };
                let status = if letter == 'R' { ChangedFileStatus::R } else { ChangedFileStatus::A };
                entries.push(NameStatusEntry { path: path.to_owned(), old_path: old_path.map(str::to_owned), status });
            }
            'M' | 'A' | 'D' | 'T' => {
                let Some(path) = tokens.next() else { break };
                let status = match letter {
                    'A' => ChangedFileStatus::A,
                    'D' => ChangedFileStatus::D,
                    _ => ChangedFileStatus::M,
                };
                entries.push(NameStatusEntry { path: path.to_owned(), old_path: None, status });
            }
            _ => {}
        }
    }
    entries
}

fn changed(
    path: &str,
    old_path: Option<&String>,
    status: ChangedFileStatus,
    untracked: bool,
    counts: Option<&&NumstatEntry>,
) -> ChangedFile {
    ChangedFile {
        path: path.to_owned(),
        old_path: old_path.filter(|p| !p.is_empty()).cloned(),
        status,
        insertions: counts.and_then(|n| n.insertions),
        deletions: counts.and_then(|n| n.deletions),
        untracked,
        patch: None,
        binary: None,
        truncated: None,
    }
}

fn by_path(numstat: &[NumstatEntry]) -> HashMap<&str, &NumstatEntry> {
    // A later entry for the same path wins, as in a JavaScript Map built from pairs.
    numstat.iter().map(|n| (n.path.as_str(), n)).collect()
}

fn sorted(mut files: Vec<ChangedFile>) -> Vec<ChangedFile> {
    files.sort_by(|a, b| locale_compare(&a.path, &b.path));
    files
}

/// The changes against a base: `git diff <base>` already lists what was
/// committed since the base and what is uncommitted; the status listing only
/// adds the untracked files.
pub fn merge_changes_with_base(
    name_status: &[NameStatusEntry],
    porcelain: &[PorcelainEntry],
    numstat: &[NumstatEntry],
) -> Vec<ChangedFile> {
    let counts = by_path(numstat);
    let mut files: Vec<ChangedFile> = name_status
        .iter()
        .filter(|e| !e.path.starts_with(MANAGED_PREFIX))
        .map(|e| changed(&e.path, e.old_path.as_ref(), e.status, false, counts.get(e.path.as_str())))
        .collect();
    let seen: HashSet<String> = files.iter().map(|f| f.path.clone()).collect();
    for e in porcelain {
        if e.x == '?' && e.y == '?' && !seen.contains(&e.path) && !e.path.starts_with(MANAGED_PREFIX) {
            files.push(changed(&e.path, None, ChangedFileStatus::A, true, None));
        }
    }
    sorted(files)
}

fn status_of(e: &PorcelainEntry) -> (ChangedFileStatus, bool) {
    let xy = e.xy();
    if xy == "??" {
        (ChangedFileStatus::A, true)
    } else if e.x == 'R' || e.y == 'R' {
        (ChangedFileStatus::R, false)
    } else if crate::git::conflict::is_unmerged_code(&xy) {
        // A file in conflict reads as modified: the conflict count speaks for it.
        (ChangedFileStatus::M, false)
    } else if e.x == 'D' || e.y == 'D' {
        (ChangedFileStatus::D, false)
    } else if e.x == 'A' {
        (ChangedFileStatus::A, false)
    } else {
        (ChangedFileStatus::M, false)
    }
}

/// The uncommitted changes: the status listing says what changed (it sees
/// untracked files), numstat gives the line counts of tracked ones.
pub fn merge_changes(porcelain: &[PorcelainEntry], numstat: &[NumstatEntry]) -> Vec<ChangedFile> {
    let counts = by_path(numstat);
    sorted(
        porcelain
            .iter()
            .filter(|e| !e.path.starts_with(MANAGED_PREFIX))
            .map(|e| {
                let (status, untracked) = status_of(e);
                changed(&e.path, e.old_path.as_ref(), status, untracked, counts.get(e.path.as_str()))
            })
            .collect(),
    )
}

/// The patch cut at the last whole line inside `max_bytes`, and whether it was cut.
pub fn truncate_patch(patch: &str, max_bytes: usize) -> (String, bool) {
    let bytes = patch.as_bytes();
    if bytes.len() <= max_bytes {
        return (patch.to_owned(), false);
    }
    let slice = &bytes[..max_bytes];
    let kept = match slice.iter().rposition(|b| *b == b'\n') {
        Some(cut) if cut > 0 => &slice[..=cut],
        _ => slice,
    };
    (String::from_utf8_lossy(kept).into_owned(), true)
}

/// Git quotes a path with special characters (`"\303\244bc.txt"`); the octal
/// escapes are UTF-8 bytes.
fn unquote_git_path(p: &str) -> String {
    if p.len() < 2 || !p.starts_with('"') || !p.ends_with('"') {
        return p.to_owned();
    }
    let inner: Vec<char> = p[1..p.len() - 1].chars().collect();
    let mut bytes: Vec<u8> = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        let ch = inner[i];
        i += 1;
        if ch != '\\' {
            bytes.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
            continue;
        }
        let Some(&next) = inner.get(i) else { break };
        i += 1;
        match next {
            'n' => bytes.push(b'\n'),
            't' => bytes.push(b'\t'),
            'r' => bytes.push(b'\r'),
            '0'..='7' => {
                let mut value = next as u32 - '0' as u32;
                let mut digits = 1;
                while digits < 3 && inner.get(i).is_some_and(|c| ('0'..='7').contains(c)) {
                    value = value * 8 + (inner[i] as u32 - '0' as u32);
                    i += 1;
                    digits += 1;
                }
                bytes.push(value as u8);
            }
            other => bytes.push(other as u32 as u8),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The value of a `+++ b/path` / `--- a/path` line as a repository path;
/// `None` for `/dev/null`.
fn strip_diff_path_prefix(raw: &str) -> Option<String> {
    let v = unquote_git_path(raw.strip_suffix('\t').unwrap_or(raw));
    if v == "/dev/null" {
        return None;
    }
    Some(v.strip_prefix("a/").or_else(|| v.strip_prefix("b/")).unwrap_or(&v).to_owned())
}

/// A binary section has no `---` / `+++` lines, only `diff --git a/P b/P`.
/// A path with spaces makes that ambiguous: the split where both halves name
/// the same path is the right one (true for everything but a rename).
fn header_path(header: Option<&&str>) -> Option<String> {
    let rest = header?.strip_prefix("diff --git ")?;
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find("\" ")? + 1;
        return strip_diff_path_prefix(&rest[..=end]);
    }
    let mut from = 0;
    while let Some(found) = rest[from..].find(" b/") {
        let sp = from + found;
        let (a_side, b_side) = (&rest[..sp], &rest[sp + 1..]);
        if a_side.starts_with("a/") && a_side[2..] == b_side[2..] {
            return Some(b_side[2..].to_owned());
        }
        from = sp + 1;
    }
    None
}

/// The file a section is about, from the lines before its first hunk (an
/// added line starting with `++ ` further down must not read as a header).
/// A deletion is named by its old path, as the changes list names it.
fn section_path(section: &[&str]) -> Option<String> {
    let (mut rename_to, mut old, mut new) = (None, None, None);
    for line in section {
        if line.starts_with("@@") {
            break;
        }
        if let Some(to) = line.strip_prefix("rename to ") {
            rename_to = Some(unquote_git_path(to));
        } else if let Some(path) = line.strip_prefix("+++ ") {
            new = strip_diff_path_prefix(path);
        } else if let Some(path) = line.strip_prefix("--- ") {
            old = strip_diff_path_prefix(path);
        }
    }
    rename_to.or(new).or(old).or_else(|| header_path(section.first())).filter(|p| !p.is_empty())
}

/// One whole-tree `git diff` cut into per-file patches, keyed by the path the
/// changes list uses. A section whose file cannot be told is dropped.
pub fn split_unified_diff(diff: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if diff.is_empty() {
        return out;
    }
    let lines: Vec<&str> = diff.split('\n').collect();
    let mut flush = |start: usize, end: usize| {
        let mut section = &lines[start..end];
        // The split leaves an empty last line: every section ends with one newline.
        while let [rest @ .., ""] = section {
            section = rest;
        }
        if let Some(path) = section_path(section) {
            out.insert(path, format!("{}\n", section.join("\n")));
        }
    };
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("diff --git ") {
            if let Some(start) = start {
                flush(start, i);
            }
            start = Some(i);
        }
    }
    if let Some(start) = start {
        flush(start, lines.len());
    }
    out
}

/// A patch section of a binary file.
pub fn is_binary_section(patch: &str) -> bool {
    patch.split('\n').any(|line| line == "GIT binary patch" || is_binary_differ_line(line))
}

/// `Binary files <a> and <b> differ`, as git prints it on a line of its own.
pub fn is_binary_differ_line(line: &str) -> bool {
    line.len() >= "Binary files  differ".len() && line.starts_with("Binary files ") && line.ends_with(" differ")
}

/// Whether a diff says its file is binary.
pub fn says_binary(diff: &str) -> bool {
    diff.split('\n').any(is_binary_differ_line)
}

/// Embeds each tracked file's patch, cut from one whole-tree diff, into the
/// changes list. A file larger than `per_file_max` is embedded truncated; one
/// that only exceeds what is left of `total_max` is left out, so asking for
/// it alone still gives it whole. Untracked files have no section.
pub fn attach_patches(files: &mut [ChangedFile], full_diff: &str, per_file_max: usize, total_max: usize) {
    let sections = split_unified_diff(full_diff);
    let mut budget = total_max;
    for file in files.iter_mut().filter(|f| !f.untracked) {
        let Some(raw) = sections.get(&file.path) else { continue };
        if is_binary_section(raw) {
            (file.patch, file.binary, file.truncated) = (Some(String::new()), Some(true), Some(false));
        } else if raw.len() > per_file_max {
            if budget < per_file_max {
                continue;
            }
            (file.patch, file.binary, file.truncated) =
                (Some(truncate_patch(raw, per_file_max).0), Some(false), Some(true));
            budget -= per_file_max;
        } else if raw.len() <= budget {
            (file.patch, file.binary, file.truncated) = (Some(raw.clone()), Some(false), Some(false));
            budget -= raw.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn porcelain(path: &str, old_path: Option<&str>, x: char, y: char) -> PorcelainEntry {
        PorcelainEntry { path: path.into(), old_path: old_path.map(str::to_owned), x, y }
    }

    fn numstat(path: &str, old_path: Option<&str>, ins: Option<i64>, del: Option<i64>) -> NumstatEntry {
        NumstatEntry { path: path.into(), old_path: old_path.map(str::to_owned), insertions: ins, deletions: del }
    }

    #[test]
    fn porcelain_entries_and_the_extra_token_of_a_rename() {
        assert_eq!(
            parse_porcelain_z(" M src/a.ts\0A  lib/b.ts\0 D old.txt\0"),
            [
                porcelain("src/a.ts", None, ' ', 'M'),
                porcelain("lib/b.ts", None, 'A', ' '),
                porcelain("old.txt", None, ' ', 'D')
            ]
        );
        assert_eq!(parse_porcelain_z("?? new file.txt\0"), [porcelain("new file.txt", None, '?', '?')]);
        assert_eq!(
            parse_porcelain_z("R  new.ts\0old.ts\0 M next.ts\0"),
            [porcelain("new.ts", Some("old.ts"), 'R', ' '), porcelain("next.ts", None, ' ', 'M')]
        );
        assert_eq!(parse_porcelain_z(""), []);
        assert_eq!(parse_porcelain_z("?? é\0"), [porcelain("é", None, '?', '?')]);
    }

    #[test]
    fn numstat_plain_rename_and_binary_forms() {
        assert_eq!(parse_numstat_z("12\t4\tsrc/a.ts\0"), [numstat("src/a.ts", None, Some(12), Some(4))]);
        let renamed = ["1\t1\t", "old.ts", "new.ts", "3\t0\tother.ts", ""].join("\0");
        assert_eq!(
            parse_numstat_z(&renamed),
            [numstat("new.ts", Some("old.ts"), Some(1), Some(1)), numstat("other.ts", None, Some(3), Some(0))]
        );
        assert_eq!(parse_numstat_z("-\t-\timg.png\0"), [numstat("img.png", None, None, None)]);
        assert_eq!(parse_numstat_z("1\t2\ta\tb.txt\0"), [numstat("a\tb.txt", None, Some(1), Some(2))]);
    }

    #[test]
    fn name_status_letters_renames_and_copies() {
        let out = ["M", "a.ts", "R100", "old.ts", "new.ts", "C75", "src.ts", "copy.ts", "T", "link", "D", "gone", ""];
        let parsed = parse_name_status_z(&out.join("\0"));
        let seen: Vec<_> = parsed.iter().map(|e| (e.path.as_str(), e.old_path.as_deref(), e.status)).collect();
        assert_eq!(
            seen,
            [
                ("a.ts", None, ChangedFileStatus::M),
                ("new.ts", Some("old.ts"), ChangedFileStatus::R),
                ("copy.ts", Some("src.ts"), ChangedFileStatus::A),
                ("link", None, ChangedFileStatus::M),
                ("gone", None, ChangedFileStatus::D),
            ]
        );
    }

    type Brief<'a> = (&'a str, ChangedFileStatus, bool, Option<i64>, Option<i64>, Option<&'a str>);

    fn brief(files: &[ChangedFile]) -> Vec<Brief<'_>> {
        files
            .iter()
            .map(|f| (f.path.as_str(), f.status, f.untracked, f.insertions, f.deletions, f.old_path.as_deref()))
            .collect()
    }

    #[test]
    fn merging_joins_counts_maps_statuses_and_sorts() {
        let status = parse_porcelain_z(
            &["?? zz.txt", " M b.ts", "R  new.ts", "old.ts", " D gone.ts", "UU clash.ts", ""].join("\0"),
        );
        let counts = parse_numstat_z(
            &["2\t1\tb.ts", "1\t1\t", "old.ts", "new.ts", "0\t5\tgone.ts", "3\t3\tclash.ts", ""].join("\0"),
        );
        assert_eq!(
            brief(&merge_changes(&status, &counts)),
            [
                ("b.ts", ChangedFileStatus::M, false, Some(2), Some(1), None),
                ("clash.ts", ChangedFileStatus::M, false, Some(3), Some(3), None),
                ("gone.ts", ChangedFileStatus::D, false, Some(0), Some(5), None),
                ("new.ts", ChangedFileStatus::R, false, Some(1), Some(1), Some("old.ts")),
                ("zz.txt", ChangedFileStatus::A, true, None, None, None),
            ]
        );
    }

    #[test]
    fn worktrees_eos_keeps_in_the_repository_are_not_changes() {
        let status = parse_porcelain_z("?? .eos/worktrees/x/f.ts\0 M a.ts\0");
        assert_eq!(merge_changes(&status, &[]).iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.ts"]);
        let names = parse_name_status_z("M\0.eos/x\0M\0a.ts\0");
        let merged = merge_changes_with_base(&names, &parse_porcelain_z("?? .eos/y\0?? new.txt\0?? a.ts\0"), &[]);
        assert_eq!(
            merged.iter().map(|f| (f.path.as_str(), f.untracked)).collect::<Vec<_>>(),
            [("a.ts", false), ("new.txt", true)]
        );
    }

    #[test]
    fn truncation_cuts_at_the_last_whole_line() {
        assert_eq!(truncate_patch("a\nb\n", 100), ("a\nb\n".to_owned(), false));
        assert_eq!(truncate_patch("line1\nline2\nline3\n", 10), ("line1\n".to_owned(), true));
        // No newline inside the cap: the cut is mid-line, and mid-character reads as U+FFFD.
        assert_eq!(truncate_patch("ééé", 3), ("é\u{fffd}".to_owned(), true));
    }

    fn section(path: &str, body: &str) -> String {
        format!("diff --git a/{path} b/{path}\nindex 111..222 100644\n--- a/{path}\n+++ b/{path}\n{body}")
    }

    #[test]
    fn a_tree_diff_splits_into_sections_by_path() {
        let diff = section("src/a.ts", "@@ -1 +1 @@\n-x\n+y\n") + &section("b.txt", "@@ -1 +1 @@\n-1\n+2\n");
        let parts = split_unified_diff(&diff);
        assert_eq!(parts.len(), 2);
        assert!(parts["src/a.ts"].starts_with("diff --git a/src/a.ts"));
        assert!(parts["b.txt"].ends_with("+2\n"));
    }

    #[test]
    fn deletions_renames_binaries_and_quoted_paths_find_their_key() {
        let deleted = "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
        assert!(split_unified_diff(deleted).contains_key("gone.txt"));
        let renamed = "diff --git a/old name.ts b/new name.ts\nsimilarity index 90%\nrename from old name.ts\nrename to new name.ts\n--- a/old name.ts\n+++ b/new name.ts\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(split_unified_diff(renamed).contains_key("new name.ts"));
        let binary = "diff --git a/img dir/p.png b/img dir/p.png\nindex 111..222 100644\nBinary files a/img dir/p.png and b/img dir/p.png differ\n";
        assert!(split_unified_diff(binary).contains_key("img dir/p.png"));
        let quoted = "diff --git \"a/\\303\\244.txt\" \"b/\\303\\244.txt\"\n--- \"a/\\303\\244.txt\"\n+++ \"b/\\303\\244.txt\"\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(split_unified_diff(quoted).contains_key("ä.txt"));
    }

    #[test]
    fn an_added_line_starting_with_plus_plus_is_not_a_header() {
        let diff =
            section("a.txt", "@@ -1 +1,2 @@\n x\n+++ not a header\n") + &section("b.txt", "@@ -1 +1 @@\n-1\n+2\n");
        let parts = split_unified_diff(&diff);
        assert_eq!(parts.len(), 2);
        assert!(parts["a.txt"].contains("+++ not a header"));
    }

    fn file(path: &str, untracked: bool) -> ChangedFile {
        ChangedFile {
            path: path.into(),
            old_path: None,
            status: ChangedFileStatus::M,
            insertions: Some(1),
            deletions: Some(1),
            untracked,
            patch: None,
            binary: None,
            truncated: None,
        }
    }

    fn plain(path: &str, body: &str) -> String {
        format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{body}")
    }

    #[test]
    fn patches_are_embedded_and_binaries_flagged() {
        let mut files = [file("a.txt", false), file("img.png", false), file("new.txt", true)];
        let diff = plain("a.txt", "@@ -1 +1 @@\n-x\n+y\n")
            + "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n"
            + &plain("new.txt", "@@ -0,0 +1 @@\n+hi\n");
        attach_patches(&mut files, &diff, 1024, 4096);
        assert!(files[0].patch.as_deref().is_some_and(|p| p.contains("+y")));
        assert_eq!(files[0].binary, Some(false));
        assert_eq!((files[1].binary, files[1].patch.as_deref()), (Some(true), Some("")));
        assert_eq!(files[2].patch, None, "an untracked file stays lazy");
    }

    #[test]
    fn an_oversized_file_is_truncated_and_one_past_the_budget_is_left_out() {
        let mut big = [file("big.txt", false)];
        let body = format!("@@ -1 +1,200 @@\n{}", "+line\n".repeat(200));
        attach_patches(&mut big, &plain("big.txt", &body), 256, 4096);
        assert_eq!(big[0].truncated, Some(true));
        assert!(big[0].patch.as_ref().is_some_and(|p| p.len() <= 256));

        let mut two = [file("a.txt", false), file("b.txt", false)];
        let body = format!("@@ -1 +1,20 @@\n{}", "+x\n".repeat(20));
        let one_section = plain("a.txt", &body).len();
        attach_patches(&mut two, &(plain("a.txt", &body) + &plain("b.txt", &body)), 1024, one_section + 10);
        assert!(two[0].patch.is_some());
        assert_eq!((two[1].patch.as_ref(), two[1].truncated), (None, None));
    }

    #[test]
    fn the_binary_line_is_matched_whole() {
        assert!(says_binary("x\nBinary files a/p and b/p differ\n"));
        assert!(!says_binary("+Binary files a/p and b/p differ\n"));
        assert!(!says_binary("Binary files differ"));
    }
}
