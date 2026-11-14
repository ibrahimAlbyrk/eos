//! Reading the record formats this adapter asks git to print.

use eos_contracts::{FsStashEntry, Num, UnpushedCommit};
use eos_core::git::DiffStat;

use crate::run::{count, parse_int};

/// `--format` for a list of commits: fields separated by the unit separator,
/// records ended by the record separator, so a subject may hold anything.
pub(crate) const LOG_FORMAT: &str = "--format=%h%x1f%an%x1f%ct%x1f%s%x1e";
pub(crate) const STASH_FORMAT: &str = "--format=%h%x1f%ct%x1f%gs%x1e";

/// A stash is a merge commit (the working tree over the index): shown against
/// its first parent it reads as the change that was stashed. Ordinary commits
/// are unaffected.
pub(crate) const FIRST_PARENT_DIFF: &str = "--diff-merges=first-parent";

/// Changes inside a submodule's own working tree are not this repository's.
pub(crate) const IGNORE_DIRTY_SUBMODULES: &str = "--ignore-submodules=dirty";

fn millis(commit_time: Option<&str>) -> Num {
    Num::from(parse_int(commit_time.unwrap_or_default()).unwrap_or(0).saturating_mul(1000))
}

pub(crate) fn parse_log_records(out: &str) -> Vec<UnpushedCommit> {
    out.split('\x1e')
        .map(str::trim)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let mut fields = record.split('\x1f');
            let sha = fields.next().unwrap_or_default();
            let author = fields.next().unwrap_or_default();
            let ts = millis(fields.next());
            let subject = fields.next().unwrap_or_default();
            (!sha.is_empty()).then(|| UnpushedCommit {
                sha: sha.to_owned(),
                author: author.to_owned(),
                ts,
                subject: subject.to_owned(),
            })
        })
        .collect()
}

/// The branch a stash was made on, from git's `WIP on <b>:` / `On <b>:` prefix.
fn stash_branch(subject: &str) -> Option<String> {
    let rest = subject.strip_prefix("WIP on ").or_else(|| subject.strip_prefix("On "))?;
    let end = rest.find(':')?;
    (end > 0).then(|| rest[..end].to_owned())
}

/// A stash's position in the list is its index (`stash@{0}` first).
pub(crate) fn parse_stash_records(out: &str) -> Vec<FsStashEntry> {
    out.split('\x1e')
        .map(str::trim)
        .filter(|record| record.split('\x1f').next().is_some_and(|sha| !sha.is_empty()))
        .enumerate()
        .map(|(index, record)| {
            let mut fields = record.split('\x1f');
            let sha = fields.next().unwrap_or_default();
            let ts = millis(fields.next());
            let subject = fields.next().unwrap_or_default();
            FsStashEntry {
                index: index as i64,
                sha: sha.to_owned(),
                subject: subject.to_owned(),
                ts,
                branch: stash_branch(subject),
            }
        })
        .collect()
}

/// ` 3 files changed, 12 insertions(+), 4 deletions(-)`; any part may be missing.
pub(crate) fn parse_short_stat(line: &str) -> DiffStat {
    let mut stat = DiffStat::default();
    for part in line.split(',') {
        let part = part.trim();
        let Some((number, label)) = part.split_once(' ') else { continue };
        if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let n = count(number);
        if label == "file changed" || label == "files changed" {
            stat.files = n;
        } else if label == "insertion(+)" || label == "insertions(+)" {
            stat.insertions = n;
        } else if label == "deletion(-)" || label == "deletions(-)" {
            stat.deletions = n;
        }
    }
    stat
}

/// `checkout: moving from <a> to <b>` lines of the HEAD reflog, newest first:
/// each `<b>` once, in order of first appearance.
pub(crate) fn parse_recent_checkouts(reflog_subjects: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for line in reflog_subjects.split('\n') {
        let Some(rest) = line.trim().strip_prefix("checkout: moving from ") else { continue };
        // The first name runs to the last " to " (a greedy match), so a branch
        // called "a to b" on the left does not cut the line short.
        let Some(at) = rest.rfind(" to ") else { continue };
        let (from, to) = (&rest[..at], &rest[at + 4..]);
        if from.is_empty() || to.is_empty() {
            continue;
        }
        if !seen.iter().any(|name| name == to) {
            seen.push(to.to_owned());
        }
    }
    seen
}

/// `origin`'s URL as a web address.
pub(crate) fn web_url(raw: &str) -> String {
    if let Some((host, path)) = raw.strip_prefix("git@").and_then(|rest| rest.split_once(':'))
        && !host.is_empty()
        && !path.is_empty()
    {
        let path = if path.len() > 4 { path.strip_suffix(".git").unwrap_or(path) } else { path };
        return format!("https://{host}/{path}");
    }
    raw.strip_suffix(".git").unwrap_or(raw).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_records_split_on_the_separators() {
        let out = "abc1234\x1fAda\x1f1700000000\x1ffix: a, b; c\x1e\ndef5678\x1fBo\x1f1700000100\x1f\x1e\n";
        let commits = parse_log_records(out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].sha, "abc1234");
        assert_eq!(commits[0].author, "Ada");
        assert_eq!(commits[0].ts, Num::from(1_700_000_000_000_i64));
        assert_eq!(commits[0].subject, "fix: a, b; c");
        assert_eq!(commits[1].subject, "");
        assert!(parse_log_records("").is_empty());
    }

    #[test]
    fn stash_records_carry_their_index_and_branch() {
        let out = "aaa\x1f1700000000\x1fWIP on feature/x: 123 msg\x1e\nbbb\x1f1700000001\x1fOn main: wip readme\x1e\nccc\x1f1\x1fcustom\x1e\n";
        let stashes = parse_stash_records(out);
        assert_eq!(stashes.iter().map(|s| s.index).collect::<Vec<_>>(), [0, 1, 2]);
        assert_eq!(stashes[0].branch.as_deref(), Some("feature/x"));
        assert_eq!(stashes[1].branch.as_deref(), Some("main"));
        assert_eq!(stashes[2].branch, None);
        assert_eq!(stashes[1].subject, "On main: wip readme");
    }

    #[test]
    fn short_stat_reads_whatever_parts_are_there() {
        assert_eq!(
            parse_short_stat(" 3 files changed, 12 insertions(+), 4 deletions(-)"),
            DiffStat { files: 3, insertions: 12, deletions: 4 }
        );
        assert_eq!(
            parse_short_stat(" 1 file changed, 2 insertions(+)"),
            DiffStat { files: 1, insertions: 2, deletions: 0 }
        );
        assert_eq!(
            parse_short_stat(" 1 file changed, 1 deletion(-)"),
            DiffStat { files: 1, insertions: 0, deletions: 1 }
        );
        assert_eq!(parse_short_stat(""), DiffStat::default());
    }

    #[test]
    fn recent_checkouts_are_most_recent_first_and_listed_once() {
        let reflog = "checkout: moving from main to feature/x\ncommit: wip\ncheckout: moving from feature/x to main\ncheckout: moving from dev to feature/x\n";
        assert_eq!(parse_recent_checkouts(reflog), ["feature/x", "main"]);
        assert!(parse_recent_checkouts("commit (initial): init\n").is_empty());
    }

    #[test]
    fn remote_urls_become_web_addresses() {
        assert_eq!(web_url("git@github.com:owner/repo.git"), "https://github.com/owner/repo");
        assert_eq!(web_url("git@github.com:owner/repo"), "https://github.com/owner/repo");
        assert_eq!(web_url("https://github.com/owner/repo.git"), "https://github.com/owner/repo");
        assert_eq!(web_url("/local/path"), "/local/path");
    }
}
