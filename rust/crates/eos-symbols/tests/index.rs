//! The index on real files in temporary folders.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use eos_contracts::{SymbolOccurrence, SymbolOccurrenceRole};
use eos_core::BoxFuture;
use eos_core::git::CandidateFiles;
use eos_core::os::SymbolIndex;
use eos_symbols::{MAX_RESIDENT_ROOTS, TagIndex};
use tokio::sync::Notify;

/// Lists a folder's files by walking it, in name order.
struct Walk;

fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) {
    let mut entries: Vec<_> = fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        if entry.path().is_dir() { walk(&entry.path(), &path, out) } else { out.push(path) }
    }
}

impl CandidateFiles for Walk {
    fn list<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, Arc<[String]>> {
        Box::pin(async move {
            let mut out = Vec::new();
            walk(root, "", &mut out);
            out.into()
        })
    }
}

struct Project {
    _keep: tempfile::TempDir,
    root: PathBuf,
}

impl Project {
    fn new(files: &[(&str, &str)]) -> Self {
        let keep = tempfile::tempdir().expect("dir");
        let root = fs::canonicalize(keep.path()).expect("real path");
        let project = Self { _keep: keep, root };
        for (name, content) in files {
            project.write(name, content);
        }
        project
    }

    fn write(&self, name: &str, content: &str) {
        let path = self.root.join(name);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(path, content).expect("write");
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }
}

fn mixed() -> Project {
    Project::new(&[
        (
            "alpha.ts",
            "export function classifyReport(x: number) { return x }\nexport class Widget { render() { return classifyReport(1) } }\nfunction helper() { return 1 }\n",
        ),
        ("beta.py", "class Foo:\n    def bar(self):\n        classifyReport()\n"),
        ("gamma.go", "package p\nfunc Serve() int { return 0 }\n"),
        ("sub/delta.ts", "function helper() { return 2 }\n"),
    ])
}

fn names(found: &[SymbolOccurrence]) -> Vec<&str> {
    found.iter().map(|o| o.name.as_str()).collect()
}

#[tokio::test]
async fn definitions_references_and_search_across_languages() {
    let (p, index) = (mixed(), TagIndex::new(Arc::new(Walk)));
    let defs = index.definitions(&p.root, "classifyReport", None).await.expect("definitions");
    assert_eq!(defs.len(), 1);
    assert_eq!(
        (defs[0].role, defs[0].kind.as_str(), defs[0].path.as_str(), defs[0].line, defs[0].column),
        (SymbolOccurrenceRole::Definition, "function", p.path("alpha.ts").as_str(), 1, 17)
    );
    assert_eq!(defs[0].line_text.as_deref(), Some("export function classifyReport(x: number) { return x }"));
    assert_eq!(index.definitions(&p.root, "Foo", None).await.expect("ok")[0].kind, "class");
    assert_eq!(index.definitions(&p.root, "bar", None).await.expect("ok")[0].path, p.path("beta.py"));
    assert_eq!(index.definitions(&p.root, "Serve", None).await.expect("ok")[0].path, p.path("gamma.go"));
    assert!(index.definitions(&p.root, "nothing", None).await.expect("ok").is_empty());

    // The definition, the call in alpha.ts and the call in beta.py, in file then source order.
    let refs = index.references(&p.root, "classifyReport").await.expect("references");
    let seen: Vec<_> = refs.iter().map(|o| (o.role, o.path.rsplit('/').next().unwrap_or_default(), o.line)).collect();
    assert_eq!(
        seen,
        [
            (SymbolOccurrenceRole::Definition, "alpha.ts", 1),
            (SymbolOccurrenceRole::Reference, "alpha.ts", 2),
            (SymbolOccurrenceRole::Reference, "beta.py", 3),
        ]
    );

    assert!(names(&index.search(&p.root, "classify", 10).await.expect("search")).contains(&"classifyReport"));
    assert_eq!(names(&index.search(&p.root, "widget", 10).await.expect("search")), ["Widget"]);
    assert_eq!(index.search(&p.root, "e", 2).await.expect("search").len(), 2, "the limit cuts the ranked list");
    // Both `helper` definitions rank alike and come in path order.
    let helpers = index.search(&p.root, "helper", 10).await.expect("search");
    assert_eq!(
        helpers.iter().map(|o| o.path.clone()).collect::<Vec<_>>(),
        [p.path("alpha.ts"), p.path("sub/delta.ts")]
    );
}

#[tokio::test]
async fn a_files_outline_needs_no_project_index() {
    let (p, index) = (mixed(), TagIndex::new(Arc::new(Walk)));
    let outline = index.definitions_in_file(&p.root, &p.root.join("alpha.ts")).await.expect("outline");
    assert!(outline.iter().all(|o| o.role == SymbolOccurrenceRole::Definition && o.path == p.path("alpha.ts")));
    assert_eq!(names(&outline), ["classifyReport", "Widget", "render", "helper"]);
    assert!(index.resident_roots().is_empty());
    assert!(index.definitions_in_file(&p.root, &p.root.join("README.md")).await.expect("ok").is_empty());
}

#[tokio::test]
async fn the_asking_file_and_its_folder_come_first() {
    let (p, index) = (mixed(), TagIndex::new(Arc::new(Walk)));
    // The last case: a file beside delta.ts that defines nothing still pulls its folder's definition up.
    for (from, first) in [("sub/delta.ts", "sub/delta.ts"), ("alpha.ts", "alpha.ts"), ("sub/other.ts", "sub/delta.ts")]
    {
        let found = index.definitions(&p.root, "helper", Some(&p.path(from))).await.expect("ok");
        assert_eq!(found[0].path, p.path(first), "asked from {from}");
    }
}

#[tokio::test]
async fn a_changed_file_is_read_again_and_a_released_project_is_rebuilt() {
    let (p, index) = (mixed(), TagIndex::new(Arc::new(Walk)));
    index.ensure_indexed(&p.root).await.expect("built");
    p.write("alpha.ts", "export function classifyThing() { return 0 }\n");
    // A change that is not source code wakes nothing and breaks nothing.
    index.invalidate(&p.root, &[p.path("README.md")]).await.expect("ok");
    assert_eq!(index.definitions(&p.root, "classifyReport", None).await.expect("ok").len(), 1);
    index.invalidate(&p.root, &[p.path("alpha.ts")]).await.expect("ok");
    assert!(index.definitions(&p.root, "classifyReport", None).await.expect("ok").is_empty());
    assert!(index.definitions(&p.root, "Widget", None).await.expect("ok").is_empty());
    assert_eq!(index.definitions(&p.root, "classifyThing", None).await.expect("ok")[0].path, p.path("alpha.ts"));
    // A deleted file leaves the index.
    fs::remove_file(p.root.join("gamma.go")).expect("remove");
    index.invalidate(&p.root, &[p.path("gamma.go")]).await.expect("ok");
    assert!(index.definitions(&p.root, "Serve", None).await.expect("ok").is_empty());

    assert_eq!(index.resident_roots(), [p.root.to_string_lossy()]);
    index.release(&p.root);
    assert!(index.resident_roots().is_empty());
    index.invalidate(&p.root, &[p.path("alpha.ts")]).await.expect("nothing resident is fine");
    assert_eq!(index.definitions(&p.root, "bar", None).await.expect("rebuilt")[0].path, p.path("beta.py"));
}

#[tokio::test]
async fn results_carry_their_source_line_and_excluded_files_stay_out() {
    let long = format!("export function longName() {{ return \"{}\" }}", "x".repeat(600));
    let filler = "let filler = 'abcdefghijklmnopqrstuvwxyz0123456789';\n";
    let p = Project::new(&[
        ("app.ts", &format!("\u{feff}export function kept() {{}}\r\n  kept()\n{long}\n")),
        ("vendor/lib/dep.js", "function vendored() {}\n"),
        ("Third_Party/dep.ts", "function thirdParty() {}\n"),
        ("vendorish/own.ts", "function vendorishOwn() {}\n"),
        ("lib.min.js", "function minName() {}\n"),
        ("bundle.js", &format!("function minified() {{}}{}\n", ";".repeat(1000))),
        ("big/huge.ts", &format!("function huge() {{}}\n{}", filler.repeat(10_500))),
        ("big/ok.ts", &format!("function nearCap() {{}}\n{}", filler.repeat(9_500))),
    ]);
    let index = TagIndex::new(Arc::new(Walk));
    let refs = index.references(&p.root, "kept").await.expect("references");
    let rows: Vec<_> = refs.iter().map(|o| (o.role, o.line, o.line_text.clone().unwrap_or_default())).collect();
    // The byte-order mark and the carriage return are part of the line.
    assert_eq!(
        rows,
        [
            (SymbolOccurrenceRole::Definition, 1, "\u{feff}export function kept() {}\r".to_owned()),
            (SymbolOccurrenceRole::Reference, 2, "  kept()".to_owned()),
        ]
    );
    let def = &index.definitions(&p.root, "longName", None).await.expect("ok")[0];
    assert_eq!(def.line_text.as_deref(), Some(&long[..500]));

    for excluded in ["vendored", "thirdParty", "minName", "minified", "huge"] {
        assert!(index.references(&p.root, excluded).await.expect("ok").is_empty(), "{excluded}");
    }
    assert_eq!(index.definitions(&p.root, "vendorishOwn", None).await.expect("ok").len(), 1);
    assert_eq!(index.definitions(&p.root, "nearCap", None).await.expect("ok").len(), 1);
    assert!(index.definitions_in_file(&p.root, &p.root.join("vendor/lib/dep.js")).await.expect("ok").is_empty());
}

/// Lists `a.ts`; the first listing waits until the test lets it go.
struct Gated {
    lists: AtomicUsize,
    started: Notify,
    open: Notify,
}

impl CandidateFiles for Gated {
    fn list<'a>(&'a self, _root: &'a Path) -> BoxFuture<'a, Arc<[String]>> {
        Box::pin(async move {
            if self.lists.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.notify_one();
                self.open.notified().await;
            }
            vec!["a.ts".to_owned()].into()
        })
    }
}

fn gated() -> (Arc<Gated>, Arc<TagIndex>, Project) {
    let files = Arc::new(Gated { lists: AtomicUsize::new(0), started: Notify::new(), open: Notify::new() });
    let project = Project::new(&[("a.ts", "function first() {}\n"), ("b.ts", "function second() {}\n")]);
    (files.clone(), Arc::new(TagIndex::new(files)), project)
}

#[tokio::test]
async fn a_change_reported_during_a_build_is_applied_once_the_build_lands() {
    let (files, index, p) = gated();
    let building = {
        let (index, root) = (index.clone(), p.root.clone());
        tokio::spawn(async move { index.ensure_indexed(&root).await })
    };
    files.started.notified().await;
    assert_eq!(index.resident_roots(), [p.root.to_string_lossy()], "a project being built counts as resident");
    let changing = {
        let (index, root, changed) = (index.clone(), p.root.clone(), vec![p.path("b.ts")]);
        tokio::spawn(async move { index.invalidate(&root, &changed).await })
    };
    files.open.notify_one();
    building.await.expect("joined").expect("built");
    changing.await.expect("joined").expect("applied");
    assert_eq!(index.definitions(&p.root, "first", None).await.expect("ok").len(), 1);
    assert_eq!(index.definitions(&p.root, "second", None).await.expect("ok").len(), 1);
}

#[tokio::test]
async fn a_project_marked_stale_during_its_build_is_built_again() {
    let (files, index, p) = gated();
    let building = {
        let (index, root) = (index.clone(), p.root.clone());
        tokio::spawn(async move { index.ensure_indexed(&root).await })
    };
    files.started.notified().await;
    index.mark_dirty(&p.root);
    files.open.notify_one();
    building.await.expect("joined").expect("built");
    index.ensure_indexed(&p.root).await.expect("rebuilt");
    assert_eq!(files.lists.load(Ordering::SeqCst), 2);
    index.ensure_indexed(&p.root).await.expect("fresh");
    assert_eq!(files.lists.load(Ordering::SeqCst), 2, "a fresh index is not rebuilt");
    index.mark_dirty(Path::new("/not/resident"));
    assert_eq!(index.resident_roots().len(), 1);
}

#[tokio::test]
async fn only_the_most_recently_used_projects_stay_in_memory() {
    let index = TagIndex::new(Arc::new(Walk));
    let projects: Vec<Project> =
        (0..MAX_RESIDENT_ROOTS + 2).map(|i| Project::new(&[("a.ts", &format!("function f{i}() {{}}\n"))])).collect();
    let seen = Mutex::new(Vec::new());
    for project in &projects {
        index.ensure_indexed(&project.root).await.expect("built");
        seen.lock().expect("lock").push(index.resident_roots().len());
    }
    assert_eq!(index.resident_roots().len(), MAX_RESIDENT_ROOTS);
    let resident = index.resident_roots();
    assert!(!resident.contains(&projects[0].root.to_string_lossy().into_owned()), "the oldest went first");
    assert!(resident.contains(&projects[MAX_RESIDENT_ROOTS + 1].root.to_string_lossy().into_owned()));
    // An evicted project is simply built again when asked for.
    assert_eq!(index.definitions(&projects[0].root, "f0", None).await.expect("ok").len(), 1);
}
