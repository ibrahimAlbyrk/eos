//! A folder's direct files (02 §4.5 "folder"). The cursor is
//! `{name: [size, mtime_ms]}` of the files counted; a listing compares the
//! folder with it. A new or changed file counts once its size and modified
//! time held for [`FOLDER_SETTLE_MS`], so a download in progress is not
//! taken half written; a file gone counts at once. The first listing of a
//! folder only keeps its cursor: what is there already starts nothing.

use std::collections::BTreeMap;
use std::path::Path;

use eos_contracts::{Fact, Facts, Num};
use eos_core::Error;
use eos_core::os::ListDirOptions;
use eos_core::signals::SignalDraft;
use eos_core::store::StoredSignalSource;
use eos_domain::signals::key;
use serde_json::json;

use super::{FOLDER_ENTRIES_MAX, FOLDER_SETTLE_MS, Local, Read, Settling, cursor_of, locked, page};

/// Files still being written by a browser or a copy.
const PARTIAL: [&str; 4] = [".download", ".crdownload", ".part", ".tmp"];

/// `{name: (size, mtime_ms)}`.
type Listing = BTreeMap<String, (u64, i64)>;

/// Whether a file is never counted: hidden, or still being written.
fn skipped(name: &str) -> bool {
    name.starts_with('.') || PARTIAL.iter().any(|suffix| name.ends_with(suffix))
}

/// The kind of a read failure, as the routine page shows it.
fn failure(error: &Error) -> &'static str {
    match error {
        Error::NotFound { .. } => "missing",
        Error::PermissionDenied(_) => "no-access",
        _ => "unreadable",
    }
}

/// What a new, changed or removed file is as a signal.
fn draft(dir: &Path, name: &str, kind: &str, (size, mtime): (u64, i64), now: i64) -> SignalDraft {
    let path = dir.join(name).to_string_lossy().into_owned();
    let (key, occurred_at) = match kind {
        super::REMOVED => (key::file_removed(&path, now), now),
        _ => (key::file(&path, size, mtime), mtime),
    };
    let version = format!("{size}-{mtime}");
    let mut facts = Facts::new();
    facts.insert("name".into(), Fact::Text(name.to_owned()));
    facts.insert("path".into(), Fact::Text(path.clone()));
    facts.insert("size".into(), Fact::Number(Num::from(i64::try_from(size).unwrap_or(i64::MAX))));
    let item = json!({
        "kind": "file", "key": key, "title": name, "path": path, "version": version, "untrusted": false,
    });
    SignalDraft { key, subject: path, version: Some(version), kind: kind.into(), occurred_at, facts, item }
}

impl Local {
    /// Lists the folder and answers the page of what changed and settled,
    /// or `None` when nothing did.
    pub(super) async fn read_folder(&self, row: &StoredSignalSource, dir: &Path) -> Read {
        let options = ListDirOptions { root: dir, include_hidden: false, apply_ignore: false };
        let entries = self.disk.list_dir(dir, options).await.map_err(|error| failure(&error))?;
        if entries.len() > FOLDER_ENTRIES_MAX {
            return Err("too-many");
        }
        let mut listing = Listing::new();
        for entry in entries.iter().filter(|entry| !entry.is_dir && !skipped(&entry.name)) {
            // A file gone between the listing and its stat is not there.
            let Ok(stat) = self.disk.stat(&entry.absolute_path).await else { continue };
            if !stat.is_dir {
                listing.insert(entry.name.clone(), (stat.size, stat.mtime_ms as i64));
            }
        }
        let Some(cursor) = cursor_of(row) else {
            return Ok(Some(page(Vec::new(), serde_json::to_value(&listing).unwrap_or_default())));
        };
        let mut kept: Listing = serde_json::from_value(cursor).unwrap_or_default();
        let now = self.clock.now_ms();
        let mut items = Vec::new();
        {
            let mut settling = locked(&self.settling);
            let waiting = settling.entry(row.id.clone()).or_default();
            waiting.retain(|name, _| listing.contains_key(name));
            for (name, stat) in &listing {
                let before = kept.get(name).copied();
                if before == Some(*stat) {
                    waiting.remove(name);
                    continue;
                }
                match waiting.get(name) {
                    Some(seen) if seen.stat == *stat && now - seen.since >= FOLDER_SETTLE_MS => {
                        waiting.remove(name);
                        let kind = if before.is_some() { "changed" } else { "added" };
                        items.push(draft(dir, name, kind, *stat, now));
                        kept.insert(name.clone(), *stat);
                    }
                    Some(seen) if seen.stat == *stat => {}
                    _ => {
                        waiting.insert(name.clone(), Settling { stat: *stat, since: now });
                    }
                }
            }
            let gone: Vec<String> = kept.keys().filter(|name| !listing.contains_key(*name)).cloned().collect();
            for name in gone {
                if let Some(stat) = kept.remove(&name) {
                    items.push(draft(dir, &name, super::REMOVED, stat, now));
                }
            }
        }
        Ok((!items.is_empty()).then(|| page(items, serde_json::to_value(&kept).unwrap_or_default())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_and_partial_files_are_never_counted() {
        for name in [".DS_Store", "a.pdf.download", "a.crdownload", "a.part", "a.tmp"] {
            assert!(skipped(name), "{name}");
        }
        assert!(!skipped("a.pdf") && !skipped("partial.txt"));
    }
}
