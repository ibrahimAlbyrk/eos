//! A working tree's changes as kept: one `git status` and one `git diff`
//! against HEAD (or against a base), and what each read takes from them.
//!
//! The status is the exact command the Changes list ran before, read by the
//! same parser. The other reads ran their own commands; each projection here
//! answers what that command answered:
//!
//! | Read | Ran | From the kept status |
//! |---|---|---|
//! | conflicts | `status --porcelain=v1 -z` | the same entries: `-uall` only splits untracked folders into files |
//! | conflict count | `status --porcelain` | records in conflict |
//! | uncommitted? | `status --porcelain` | a record whose printed path is not under `.eos/` (git quotes a path with a space or a special character, and a quoted one never counts as `.eos/`) |
//! | untracked count | `ls-files --others --exclude-standard` in the folder asked about | untracked records below that folder, by the path `ls-files` prints |
//! | short stat | `diff --shortstat <base>` | printed by the same `git diff` as the line counts (`--numstat --shortstat`) |

use std::sync::OnceLock;

use eos_contracts::ChangedFile;
use eos_core::git::{ConflictEntry, DiffStat};
use eos_domain::git::changes::{
    NameStatusEntry, NumstatEntry, PorcelainEntry, merge_changes, merge_changes_with_base, parse_name_status_z,
    parse_numstat_z, parse_porcelain_z,
};
use eos_domain::git::conflict::is_unmerged_code;

use crate::info::is_managed;
use crate::records::{IGNORE_DIRTY_SUBMODULES, parse_short_stat};
use crate::run::{Failed, Ran};

/// `git status` as the Changes list asks for it.
pub(super) const STATUS: [&str; 5] = ["status", "--porcelain=v1", "-z", "-uall", IGNORE_DIRTY_SUBMODULES];

/// Line counts and the short stat of the working tree against `base`, from one `git diff`.
pub(super) fn diff_args(base: &str) -> [&str; 6] {
    ["diff", "--numstat", "--shortstat", "-z", IGNORE_DIRTY_SUBMODULES, base]
}

pub(super) fn name_status_args(base: &str) -> [&str; 5] {
    ["diff", "--name-status", "-z", IGNORE_DIRTY_SUBMODULES, base]
}

/// Why the status is missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Missing {
    /// More output than a command may print: the commands that did not split
    /// untracked folders may still have answered, so those reads ask git.
    TooLarge,
    Failed,
}

/// One status entry with the original path git printed after a rename or copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Record {
    x: char,
    y: char,
    path: String,
    orig: Option<String>,
}

#[derive(Debug)]
pub(super) struct StatusList {
    /// As the Changes list's parser reads them.
    pub(super) entries: Vec<PorcelainEntry>,
    records: Vec<Record>,
}

/// `--numstat` rows and the `--shortstat` line of one `git diff`.
#[derive(Debug)]
pub(super) struct Numstat {
    pub(super) rows: Vec<NumstatEntry>,
    pub(super) stat: DiffStat,
}

/// The working tree against HEAD.
#[derive(Debug)]
pub(super) struct Listing {
    pub(super) status: Result<StatusList, Missing>,
    /// `None` when the diff failed (no commit yet).
    pub(super) diff: Option<Numstat>,
    changed: OnceLock<Vec<ChangedFile>>,
}

/// The working tree against a base (a worktree's fork point, a branch's merge base).
#[derive(Debug)]
pub(super) struct Against {
    pub(super) names: Option<Vec<NameStatusEntry>>,
    pub(super) diff: Option<Numstat>,
}

/// Whether git prints `path` in quotes (with `core.quotePath` on, as by
/// default). `space`: a space alone makes it quote, as the short status
/// format does (`ls-files` does not).
fn quoted(path: &str, space: bool) -> bool {
    path.bytes().any(|b| b < 0x20 || b == b'"' || b == b'\\' || b >= 0x7f || (space && b == b' '))
}

impl Record {
    fn is_unmerged(&self) -> bool {
        is_unmerged_code(&String::from_iter([self.x, self.y]))
    }

    /// What `has_uncommitted_changes` skipped: a line of `git status
    /// --porcelain` that reads as a path under `.eos/` (or `.eos` itself).
    /// A rename prints `<orig> -> <path>`.
    fn is_managed_line(&self) -> bool {
        match &self.orig {
            Some(orig) => !quoted(orig, true) && orig.starts_with(".eos/"),
            None => !quoted(&self.path, true) && is_managed(&self.path),
        }
    }
}

/// Every entry of `git status --porcelain=v1 -z`; a rename or copy on
/// either side is followed by its original path.
fn records(out: &str) -> Vec<Record> {
    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    let mut records = Vec::new();
    while let Some(token) = tokens.next() {
        let mut chars = token.chars();
        let (Some(x), Some(y), Some(' ')) = (chars.next(), chars.next(), chars.next()) else { continue };
        let orig =
            if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') { tokens.next().map(str::to_owned) } else { None };
        records.push(Record { x, y, path: chars.as_str().to_owned(), orig });
    }
    records
}

impl StatusList {
    pub(super) fn read(out: &str) -> Self {
        Self { entries: parse_porcelain_z(out), records: records(out) }
    }

    pub(super) fn conflict_count(&self) -> u32 {
        self.records.iter().filter(|r| r.is_unmerged()).count() as u32
    }

    pub(super) fn conflicts(&self) -> Vec<ConflictEntry> {
        self.entries
            .iter()
            .filter(|e| is_unmerged_code(&e.xy()) && !e.path.starts_with(".eos/"))
            .map(|e| ConflictEntry { xy: e.xy(), path: e.path.clone() })
            .collect()
    }

    pub(super) fn has_uncommitted(&self) -> bool {
        self.records.iter().any(|r| !r.path.is_empty() && !r.is_managed_line())
    }

    /// Untracked files `ls-files --others` lists from the folder at `prefix`
    /// (relative to the top, ending in `/`, empty at the top), not counting
    /// what Eos keeps under `.eos/`.
    pub(super) fn untracked_below(&self, prefix: &str) -> u32 {
        self.records
            .iter()
            .filter(|r| r.x == '?' && r.y == '?')
            .filter_map(|r| r.path.strip_prefix(prefix))
            .filter(|listed| !listed.is_empty() && (quoted(listed, false) || !is_managed(listed)))
            .count() as u32
    }
}

impl Numstat {
    /// The rows end in NUL; the short stat is the line after the last one.
    pub(super) fn read(out: &str) -> Self {
        let (rows, stat) = match out.rfind('\0') {
            Some(at) => out.split_at(at + 1),
            None => ("", out),
        };
        Self { rows: parse_numstat_z(rows), stat: parse_short_stat(stat.trim()) }
    }
}

impl Listing {
    pub(super) fn read(status: Result<Ran, Failed>, diff: Result<Ran, Failed>) -> Self {
        let status = match status {
            Ok(ran) => Ok(StatusList::read(&ran.text())),
            Err(failed) if failed.is_too_large() => Err(Missing::TooLarge),
            Err(_) => Err(Missing::Failed),
        };
        Self { status, diff: diff.ok().map(|ran| Numstat::read(&ran.text())), changed: OnceLock::new() }
    }

    /// The Changes list against HEAD; without a commit yet, without line counts.
    pub(super) fn changed(&self) -> Vec<ChangedFile> {
        let Ok(status) = &self.status else { return Vec::new() };
        let rows = self.diff.as_ref().map_or(&[][..], |diff| &diff.rows);
        self.changed.get_or_init(|| merge_changes(&status.entries, rows)).clone()
    }

    pub(super) fn stat(&self) -> DiffStat {
        self.diff.as_ref().map(|diff| diff.stat).unwrap_or_default()
    }
}

impl Against {
    pub(super) fn read(names: Result<Ran, Failed>, diff: Result<Ran, Failed>) -> Self {
        Self {
            names: names.ok().map(|ran| parse_name_status_z(&ran.text())),
            diff: diff.ok().map(|ran| Numstat::read(&ran.text())),
        }
    }

    /// The Changes list against the base; empty when any of the three commands failed.
    pub(super) fn changed(&self, listing: &Listing) -> Vec<ChangedFile> {
        match (&listing.status, &self.names, &self.diff) {
            (Ok(status), Some(names), Some(diff)) => merge_changes_with_base(names, &status.entries, &diff.rows),
            _ => Vec::new(),
        }
    }

    pub(super) fn stat(&self) -> DiffStat {
        self.diff.as_ref().map(|diff| diff.stat).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_take_the_original_path_on_either_side() {
        let out = "R  new\0old\0 R moved\0was\0?? a b\0UU c\0";
        let got = records(out);
        let paths: Vec<(&str, Option<&str>)> = got.iter().map(|r| (r.path.as_str(), r.orig.as_deref())).collect();
        assert_eq!(paths, [("new", Some("old")), ("moved", Some("was")), ("a b", None), ("c", None)]);
        let list = StatusList::read(out);
        assert_eq!(list.conflict_count(), 1);
    }

    #[test]
    fn a_path_under_eos_is_not_an_uncommitted_change_unless_git_quotes_it() {
        let only = |out: &str| StatusList::read(out).has_uncommitted();
        assert!(!only("?? .eos/worktrees/w1/\0"));
        assert!(!only("?? .eos\0"));
        assert!(only("?? .eos/a b\0"), "printed in quotes");
        assert!(only("?? .eos/\u{e9}\0"), "printed in quotes");
        assert!(only("?? .eosx\0"));
        assert!(!only("R  out\0.eos/in\0"), "printed as `.eos/in -> out`");
        assert!(only("R  .eos/in\0out\0"));
        assert!(!only(""));
    }

    #[test]
    fn untracked_files_count_as_ls_files_lists_them_from_the_folder() {
        let list = StatusList::read("?? a.txt\0?? sub/b.txt\0?? sub/.eos/x\0?? .eos/y\0?? sub/\u{e9}\0 M sub/c\0");
        assert_eq!(list.untracked_below(""), 4, ".eos/y is skipped, sub/.eos/x is not");
        assert_eq!(list.untracked_below("sub/"), 2, "x under the folder's own .eos is skipped; é is printed quoted");
        assert_eq!(list.untracked_below("none/"), 0);
    }

    #[test]
    fn the_short_stat_follows_the_rows() {
        let diff = Numstat::read("1\t2\ta.txt\0-\t-\tb.bin\0 2 files changed, 1 insertion(+), 2 deletions(-)\n");
        assert_eq!(diff.rows.len(), 2);
        assert_eq!(diff.stat, DiffStat { insertions: 1, deletions: 2, files: 2 });
        let empty = Numstat::read("");
        assert_eq!((empty.rows.len(), empty.stat), (0, DiffStat::default()));
    }
}
