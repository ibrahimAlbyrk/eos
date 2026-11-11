//! File-name search over a project, and the list of files it searches.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use eos_contracts::{FsEntry, FsEntryType};
use eos_core::git::CandidateFiles;
use eos_core::{BoxFuture, Clock};
use eos_domain::text::locale_compare;
use tokio::sync::OnceCell;

use crate::http::text;

/// How long a project's file list is reused when nothing invalidates it.
const LIST_TTL_MS: i64 = 10_000;
/// Projects whose list is kept; the least recently used goes first.
const MAX_ROOTS: usize = 8;

struct Listing {
    root: PathBuf,
    at: i64,
    /// Filled once; callers that arrive while it is being listed wait for the same answer.
    files: Arc<OnceCell<Arc<[String]>>>,
}

/// One list of candidate files per project, shared by file search and the
/// symbol index. A change of an entry under a project, or of its git state,
/// drops its list ([`invalidate`](Self::invalidate)); the age limit bounds how
/// stale a project that nothing watches can get.
pub struct CandidateCache {
    source: Arc<dyn CandidateFiles>,
    clock: Arc<dyn Clock>,
    /// Least recently used first.
    listings: Mutex<Vec<Listing>>,
}

impl std::fmt::Debug for CandidateCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CandidateCache").field("roots", &self.roots()).finish()
    }
}

impl CandidateCache {
    pub fn new(source: Arc<dyn CandidateFiles>, clock: Arc<dyn Clock>) -> Self {
        Self { source, clock, listings: Mutex::new(Vec::new()) }
    }

    /// The projects that hold a list.
    pub fn roots(&self) -> Vec<PathBuf> {
        self.listings.lock().unwrap_or_else(|p| p.into_inner()).iter().map(|l| l.root.clone()).collect()
    }

    pub fn invalidate(&self, root: &Path) {
        self.listings.lock().unwrap_or_else(|p| p.into_inner()).retain(|l| l.root != root);
    }

    fn slot(&self, root: &Path) -> Arc<OnceCell<Arc<[String]>>> {
        let now = self.clock.now_ms();
        let mut listings = self.listings.lock().unwrap_or_else(|p| p.into_inner());
        let known = listings.iter().position(|l| l.root == root).map(|at| listings.remove(at));
        let listing = match known {
            Some(listing) if now - listing.at < LIST_TTL_MS => listing,
            _ => Listing { root: root.to_owned(), at: now, files: Arc::new(OnceCell::new()) },
        };
        let files = listing.files.clone();
        listings.push(listing);
        if listings.len() > MAX_ROOTS {
            listings.remove(0);
        }
        files
    }
}

impl CandidateFiles for CandidateCache {
    fn list<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Arc<[String]>> {
        Box::pin(async move { self.slot(root).get_or_init(|| self.source.list(root)).await.clone() })
    }
}

fn score(name: &str, relative: &str, query: &str) -> u32 {
    let (name, relative) = (name.to_lowercase(), relative.to_lowercase());
    if name == query {
        100
    } else if name.starts_with(query) {
        80
    } else if name.contains(query) {
        60
    } else if relative.contains(query) {
        30
    } else {
        0
    }
}

fn entry(cwd: &Path, name: &str, relative: &str, r#type: FsEntryType) -> FsEntry {
    FsEntry {
        name: name.to_owned(),
        absolute_path: text(&cwd.join(relative)),
        relative_path: relative.to_owned(),
        r#type,
        is_symlink: None,
    }
}

/// Folders first, then by name as the dashboard orders names.
fn by_kind_then_name(a: &FsEntry, b: &FsEntry) -> std::cmp::Ordering {
    (b.r#type == FsEntryType::Directory)
        .cmp(&(a.r#type == FsEntryType::Directory))
        .then_with(|| locale_compare(&a.name, &b.name))
}

/// The files and folders of a project whose name (or, failing that, path)
/// contains `query` (already lower case): an exact name first, then a name
/// starting with it, then one containing it, then a path containing it. A
/// folder ranks just above a file of the same match.
///
/// `limit` cuts the ranked list; a negative one drops that many from its end.
pub(crate) fn search_project(files: &[String], cwd: &Path, query: &str, limit: i64) -> Vec<FsEntry> {
    let mut scored: Vec<(FsEntry, u32)> = Vec::new();
    let mut seen_dirs: HashSet<&str> = HashSet::new();
    for file in files {
        let mut end = 0;
        for part in file.split('/') {
            let start = end + usize::from(end > 0);
            end = start + part.len();
            if end == file.len() {
                break;
            }
            let dir = &file[..end];
            if seen_dirs.insert(dir) {
                let s = score(part, dir, query);
                if s > 0 {
                    scored.push((entry(cwd, part, dir, FsEntryType::Directory), s + 1));
                }
            }
        }
    }
    for file in files {
        let name = file.rsplit('/').next().unwrap_or(file);
        let s = score(name, file, query);
        if s > 0 {
            scored.push((entry(cwd, name, file, FsEntryType::File), s));
        }
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| by_kind_then_name(&a.0, &b.0)));
    let keep = match usize::try_from(limit) {
        Ok(limit) => limit,
        Err(_) => scored.len().saturating_sub(usize::try_from(limit.unsigned_abs()).unwrap_or(usize::MAX)),
    };
    scored.into_iter().take(keep).map(|(entry, _)| entry).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    use super::*;

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn names(found: &[FsEntry]) -> Vec<(&str, FsEntryType)> {
        found.iter().map(|e| (e.relative_path.as_str(), e.r#type)).collect()
    }

    #[test]
    fn matches_rank_exact_then_prefix_then_inside_then_path() {
        let list =
            files(&["src/parser.js", "src/cli.js", "docs/parser/notes.md", "lib/sparse.js", "parser", "x/y.txt"]);
        let found = search_project(&list, Path::new("/p"), "parser", 10);
        assert_eq!(
            names(&found),
            [
                ("docs/parser", FsEntryType::Directory),
                ("parser", FsEntryType::File),
                ("src/parser.js", FsEntryType::File),
                ("docs/parser/notes.md", FsEntryType::File),
            ]
        );
        assert_eq!(found[2].absolute_path, "/p/src/parser.js");
        assert_eq!(found[2].name, "parser.js");
        assert_eq!(found[2].is_symlink, None, "search entries carry no link flag");
    }

    #[test]
    fn the_limit_cuts_after_ranking_and_folders_are_listed_once() {
        let list = files(&["src/a.js", "src/b.js", "src/deep/c.js"]);
        let found = search_project(&list, Path::new("/p"), "src", 10);
        assert_eq!(names(&found)[0], ("src", FsEntryType::Directory));
        // `src/deep` matches by its path, once, though two files lie below `src`.
        assert_eq!(names(&found)[1], ("src/deep", FsEntryType::Directory));
        assert_eq!(found.len(), 5);
        assert_eq!(search_project(&list, Path::new("/p"), "src", 2).len(), 2);
        assert!(search_project(&list, Path::new("/p"), "zzz", 10).is_empty());
        assert_eq!(search_project(&list, Path::new("/p"), "src", -1).len(), 4, "a negative limit drops from the end");
    }

    struct Counting {
        calls: AtomicUsize,
    }

    impl CandidateFiles for Counting {
        fn list<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Arc<[String]>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { vec![format!("{}/file", root.display())].into() })
        }
    }

    struct Clock0(AtomicI64);

    impl Clock for Clock0 {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn cache() -> (CandidateCache, Arc<Counting>, Arc<Clock0>) {
        let (source, clock) = (Arc::new(Counting { calls: AtomicUsize::new(0) }), Arc::new(Clock0(AtomicI64::new(0))));
        (CandidateCache::new(source.clone(), clock.clone()), source, clock)
    }

    #[tokio::test]
    async fn a_project_is_listed_once_until_it_is_invalidated_or_too_old() {
        let (cache, source, clock) = cache();
        let root = Path::new("/a");
        let (one, two) = tokio::join!(cache.list(root), cache.list(root));
        assert_eq!((one.len(), two.len()), (1, 1));
        cache.list(root).await;
        assert_eq!(source.calls.load(Ordering::SeqCst), 1, "concurrent and repeated callers share one listing");

        cache.invalidate(root);
        cache.list(root).await;
        assert_eq!(source.calls.load(Ordering::SeqCst), 2);

        clock.0.store(LIST_TTL_MS - 1, Ordering::SeqCst);
        cache.list(root).await;
        assert_eq!(source.calls.load(Ordering::SeqCst), 2);
        clock.0.store(LIST_TTL_MS, Ordering::SeqCst);
        cache.list(root).await;
        assert_eq!(source.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn only_the_most_recently_used_projects_are_kept() {
        let (cache, source, _clock) = cache();
        for i in 0..9 {
            cache.list(Path::new(&format!("/r{i}"))).await;
        }
        assert_eq!(cache.roots().len(), MAX_ROOTS);
        assert!(!cache.roots().contains(&PathBuf::from("/r0")));
        // Using a project again moves it to the recent end.
        cache.list(Path::new("/r1")).await;
        cache.list(Path::new("/r9")).await;
        assert!(cache.roots().contains(&PathBuf::from("/r1")) && !cache.roots().contains(&PathBuf::from("/r2")));
        assert_eq!(source.calls.load(Ordering::SeqCst), 10);
    }
}
