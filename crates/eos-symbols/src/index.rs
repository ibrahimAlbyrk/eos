//! The per-project index and the queries over it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{SymbolOccurrence, SymbolOccurrenceRole};
use eos_core::git::CandidateFiles;
use eos_core::os::SymbolIndex;
use eos_core::{BoxFuture, Error};
use eos_domain::text::locale_compare;
use indexmap::IndexMap;

use crate::languages::indexable;
use crate::parse::{Occurrence, parse_file};

/// Projects whose index is kept in memory.
pub const MAX_RESIDENT_ROOTS: usize = 6;
/// Files parsed for one project; the rest are skipped and the skip is logged.
const MAX_FILES: usize = 20_000;
/// UTF-16 units kept of the source line shown with a result.
const LINE_TEXT_MAX: usize = 500;

/// An occurrence with the file it is in.
#[derive(Debug, Clone)]
struct Located {
    path: Arc<str>,
    occurrence: Occurrence,
}

#[derive(Debug, Default)]
struct RootIndex {
    /// Every occurrence by name, names in the order they were first seen.
    by_name: IndexMap<Arc<str>, Vec<Located>>,
    /// The names each file contributed, to take a file back out.
    by_file: HashMap<Arc<str>, Vec<Arc<str>>>,
    last_used: u64,
}

impl RootIndex {
    fn add(&mut self, path: &Path, occurrences: Vec<Occurrence>) {
        if occurrences.is_empty() {
            return;
        }
        let path: Arc<str> = path.to_string_lossy().as_ref().into();
        let mut names: Vec<Arc<str>> = Vec::new();
        for occurrence in occurrences {
            let name = match self.by_name.get_full(&occurrence.name) {
                // One allocation per distinct name in a project, however often it occurs.
                Some((_, name, _)) => name.clone(),
                None => occurrence.name.clone(),
            };
            if !names.iter().any(|known| Arc::ptr_eq(known, &name)) {
                names.push(name.clone());
            }
            let occurrence = Occurrence { name: name.clone(), ..occurrence };
            self.by_name.entry(name).or_default().push(Located { path: path.clone(), occurrence });
        }
        self.by_file.insert(path, names);
    }

    fn remove(&mut self, path: &str) {
        let Some(names) = self.by_file.remove(path) else { return };
        for name in names {
            let Some(occurrences) = self.by_name.get_mut(&name) else { continue };
            occurrences.retain(|located| located.path.as_ref() != path);
            if occurrences.is_empty() {
                // Keeps the order of the names that stay.
                self.by_name.shift_remove(&name);
            }
        }
    }
}

#[derive(Default)]
struct State {
    indexes: HashMap<PathBuf, RootIndex>,
    building: HashSet<PathBuf>,
    dirty: HashSet<PathBuf>,
    clock: u64,
}

impl State {
    fn touch(&mut self, root: &Path) {
        self.clock += 1;
        let now = self.clock;
        if let Some(index) = self.indexes.get_mut(root) {
            index.last_used = now;
        }
    }

    fn evict(&mut self) {
        while self.indexes.len() > MAX_RESIDENT_ROOTS {
            let Some(oldest) =
                self.indexes.iter().min_by_key(|(_, index)| index.last_used).map(|(root, _)| root.clone())
            else {
                return;
            };
            self.indexes.remove(&oldest);
            self.dirty.remove(&oldest);
            tracing::info!(root = %oldest.display(), cap = MAX_RESIDENT_ROOTS, "symbol index evicted: least recently used");
        }
    }
}

/// The `SymbolIndex` port over tree-sitter tag queries.
pub struct TagIndex {
    files: Arc<dyn CandidateFiles>,
    state: Mutex<State>,
    /// Parsing is one request at a time: a build and the invalidations that
    /// arrive during it are applied in order.
    parsing: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for TagIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TagIndex").field("roots", &self.resident_roots()).finish()
    }
}

fn unavailable(cause: impl std::fmt::Display) -> Error {
    Error::Storage(format!("symbol index unavailable: {cause}"))
}

/// Parses `paths` off the async threads. Each parsed file comes back with its
/// occurrences, in the order given; `skipped` counts files left out by the cap.
async fn parse_all(paths: Vec<PathBuf>) -> Result<(Vec<(PathBuf, Vec<Occurrence>)>, usize), Error> {
    tokio::task::spawn_blocking(move || {
        let (mut parsed, mut count, mut skipped) = (Vec::new(), 0usize, 0usize);
        for path in paths {
            if count >= MAX_FILES {
                skipped += 1;
                continue;
            }
            if let Some(occurrences) = parse_file(&path) {
                count += 1;
                parsed.push((path, occurrences));
            }
        }
        (parsed, skipped)
    })
    .await
    .map_err(unavailable)
}

/// The first `LINE_TEXT_MAX` UTF-16 units of a line.
fn clip(line: &str) -> String {
    let mut units = 0;
    for (at, ch) in line.char_indices() {
        units += ch.len_utf16();
        if units > LINE_TEXT_MAX {
            return line[..at].to_owned();
        }
    }
    line.to_owned()
}

/// The results as the wire carries them, each with its source line (read
/// once per file, now).
async fn with_line_text(found: Vec<Located>) -> Vec<SymbolOccurrence> {
    tokio::task::spawn_blocking(move || {
        let mut files: HashMap<Arc<str>, Vec<String>> = HashMap::new();
        found
            .into_iter()
            .map(|Located { path, occurrence }| {
                let lines = files.entry(path.clone()).or_insert_with(|| {
                    fs::read(path.as_ref())
                        .map(|bytes| String::from_utf8_lossy(&bytes).split('\n').map(str::to_owned).collect())
                        .unwrap_or_default()
                });
                let line =
                    lines.get(occurrence.line.saturating_sub(1) as usize).map(String::as_str).unwrap_or_default();
                SymbolOccurrence {
                    name: occurrence.name.to_string(),
                    kind: occurrence.kind.to_string(),
                    role: if occurrence.definition {
                        SymbolOccurrenceRole::Definition
                    } else {
                        SymbolOccurrenceRole::Reference
                    },
                    path: path.to_string(),
                    line: i64::from(occurrence.line),
                    column: i64::from(occurrence.column),
                    line_text: Some(clip(line)),
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// How a name ranks for a query, as file names rank in file search.
fn score(name: &str, query: &str) -> u32 {
    if name == query {
        100
    } else if name.starts_with(query) {
        80
    } else if name.contains(query) {
        60
    } else {
        0
    }
}

impl TagIndex {
    /// `files` lists a project's candidate files (relative paths), the same
    /// list file search uses.
    pub fn new(files: Arc<dyn CandidateFiles>) -> Self {
        Self { files, state: Mutex::new(State::default()), parsing: tokio::sync::Mutex::new(()) }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether `root` holds an index that is not stale; marks it used.
    fn fresh(&self, root: &Path) -> bool {
        let mut state = self.state();
        let fresh = state.indexes.contains_key(root) && !state.dirty.contains(root);
        if fresh {
            state.touch(root);
        }
        fresh
    }

    async fn build(&self, root: &Path) -> Result<RootIndex, Error> {
        let listed = self.files.list(root).await;
        let paths: Vec<PathBuf> =
            listed.iter().map(|rel| root.join(rel)).filter(|path| indexable(root, path)).collect();
        let (parsed, skipped) = parse_all(paths).await?;
        if skipped > 0 {
            tracing::warn!(root = %root.display(), cap = MAX_FILES, skipped, "symbol index file cap hit: some files skipped");
        }
        let mut index = RootIndex::default();
        for (path, occurrences) in parsed {
            index.add(&path, occurrences);
        }
        Ok(index)
    }

    async fn ensure(&self, root: &Path) -> Result<(), Error> {
        if self.fresh(root) {
            return Ok(());
        }
        let _turn = self.parsing.lock().await;
        // Another caller may have built it while this one waited.
        if self.fresh(root) {
            return Ok(());
        }
        {
            // Cleared before the build: a change reported while it runs leaves its result stale.
            let mut state = self.state();
            state.dirty.remove(root);
            state.building.insert(root.to_owned());
        }
        let built = self.build(root).await;
        let mut state = self.state();
        state.building.remove(root);
        match built {
            Ok(index) => {
                state.indexes.insert(root.to_owned(), index);
                state.touch(root);
                state.evict();
                Ok(())
            }
            Err(e) => {
                if state.indexes.contains_key(root) {
                    state.dirty.insert(root.to_owned());
                }
                Err(e)
            }
        }
    }

    fn named(&self, root: &Path, name: &str) -> Vec<Located> {
        self.state().indexes.get(root).and_then(|index| index.by_name.get(name)).cloned().unwrap_or_default()
    }
}

/// 0 for the same file, 1 for the same folder, 2 for anywhere else.
fn proximity(path: &str, from: &Path) -> u8 {
    let path = Path::new(path);
    if path == from {
        0
    } else if path.parent() == from.parent() {
        1
    } else {
        2
    }
}

impl SymbolIndex for TagIndex {
    fn ensure_indexed<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.ensure(root))
    }

    fn definitions<'a>(
        &'a self,
        root: &'a Path,
        name: &'a str,
        from_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>> {
        Box::pin(async move {
            self.ensure(root).await?;
            let mut found = self.named(root, name);
            found.retain(|located| located.occurrence.definition);
            // A definition in the asking file, then in its folder, comes first:
            // a likely guess, not a resolution.
            if let Some(from) = from_path.filter(|_| found.len() >= 2) {
                found.sort_by_key(|located| proximity(&located.path, Path::new(from)));
            }
            Ok(with_line_text(found).await)
        })
    }

    fn references<'a>(&'a self, root: &'a Path, name: &'a str) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>> {
        Box::pin(async move {
            self.ensure(root).await?;
            Ok(with_line_text(self.named(root, name)).await)
        })
    }

    fn search<'a>(
        &'a self,
        root: &'a Path,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>> {
        Box::pin(async move {
            self.ensure(root).await?;
            let query = query.to_lowercase();
            let mut scored: Vec<(u32, Located)> = Vec::new();
            {
                let state = self.state();
                let Some(index) = state.indexes.get(root) else { return Ok(Vec::new()) };
                for (name, occurrences) in &index.by_name {
                    let score = score(&name.to_lowercase(), &query);
                    if score == 0 {
                        continue;
                    }
                    // A name's definitions; a name that is only ever used shows its first use.
                    let definitions = occurrences.iter().filter(|located| located.occurrence.definition);
                    let before = scored.len();
                    scored.extend(definitions.map(|located| (score, located.clone())));
                    if scored.len() == before {
                        scored.extend(occurrences.first().map(|located| (score, located.clone())));
                    }
                }
            }
            scored.sort_by(|(a_score, a), (b_score, b)| {
                b_score
                    .cmp(a_score)
                    .then_with(|| locale_compare(&a.occurrence.name, &b.occurrence.name))
                    .then_with(|| locale_compare(&a.path, &b.path))
            });
            scored.truncate(limit);
            Ok(with_line_text(scored.into_iter().map(|(_, located)| located).collect()).await)
        })
    }

    fn definitions_in_file<'a>(
        &'a self,
        root: &'a Path,
        path: &'a Path,
    ) -> BoxFuture<'a, Result<Vec<SymbolOccurrence>, Error>> {
        Box::pin(async move {
            if !indexable(root, path) {
                return Ok(Vec::new());
            }
            // One parse of one file: an outline must not index the project.
            let (parsed, _) = parse_all(vec![path.to_owned()]).await?;
            let shown: Arc<str> = path.to_string_lossy().as_ref().into();
            let definitions = parsed
                .into_iter()
                .flat_map(|(_, occurrences)| occurrences)
                .filter(|occurrence| occurrence.definition)
                .map(|occurrence| Located { path: shown.clone(), occurrence })
                .collect();
            Ok(with_line_text(definitions).await)
        })
    }

    fn invalidate<'a>(&'a self, root: &'a Path, changed: &'a [String]) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            // After a build in flight: it may have read these files' old content.
            let _turn = self.parsing.lock().await;
            if !self.state().indexes.contains_key(root) {
                return Ok(());
            }
            // Only source files are parsed; any other change just leaves the index.
            let sources: Vec<PathBuf> =
                changed.iter().map(PathBuf::from).filter(|path| indexable(root, path)).collect();
            let parsed = if sources.is_empty() { Vec::new() } else { parse_all(sources).await?.0 };
            let mut state = self.state();
            let Some(index) = state.indexes.get_mut(root) else { return Ok(()) };
            for path in changed {
                index.remove(path);
            }
            for (path, occurrences) in parsed {
                index.add(&path, occurrences);
            }
            Ok(())
        })
    }

    fn mark_dirty(&self, root: &Path) {
        let mut state = self.state();
        if state.indexes.contains_key(root) || state.building.contains(root) {
            state.dirty.insert(root.to_owned());
        }
    }

    fn release(&self, root: &Path) {
        let mut state = self.state();
        state.indexes.remove(root);
        state.dirty.remove(root);
    }

    fn resident_roots(&self) -> Vec<String> {
        let state = self.state();
        let mut roots: Vec<String> = state.indexes.keys().map(|root| root.to_string_lossy().into_owned()).collect();
        for root in &state.building {
            let root = root.to_string_lossy().into_owned();
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        roots
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_cut_at_500_utf16_units() {
        assert_eq!(clip("short"), "short");
        assert_eq!(clip(&"x".repeat(600)).len(), 500);
        // An astral character is two units and is never split.
        let astral = "😀".repeat(300);
        assert_eq!(clip(&astral).chars().count(), 250);
    }

    #[test]
    fn names_rank_exact_then_prefix_then_inside() {
        assert_eq!(score("widget", "widget"), 100);
        assert_eq!(score("widgetfactory", "widget"), 80);
        assert_eq!(score("mywidget", "widget"), 60);
        assert_eq!(score("other", "widget"), 0);
    }
}
