//! The routes over the real adapters, on folders and repositories made in the
//! temporary folder. The generic host stands in for the desktop: nothing is
//! opened on a screen and nothing reaches the real Trash.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use eos_core::SystemClock;
use eos_core::os::FileWatcher;
use eos_git::Git;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_mod_fs::{CandidateCache, FsModule, Ports, fs_change_sink, git_change_sink};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request, Response};
use eos_runtime::router::{AllPluginsOn, Router};
use eos_runtime::stream::AttachOptions;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_watch::{DirWatcher, RepoWatcher, ResolveGitDirs};
use serde_json::{Value, json};

struct App {
    _keep: tempfile::TempDir,
    /// A folder for the test's files, by its real path.
    root: PathBuf,
    runtime: Runtime,
    raw: Router,
    dirs: Arc<DirWatcher>,
    repos: Arc<RepoWatcher>,
}

fn app() -> App {
    let keep = tempfile::tempdir().expect("a temporary folder");
    let root = fs::canonicalize(keep.path()).expect("its real path");
    let host = eos_platform::generic_host();
    let clock = Arc::new(SystemClock);
    let trees = ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok());
    let git = Arc::new(Git::new(Runner::new(trees), clock.clone()));
    let resolve: ResolveGitDirs = {
        let git = git.clone();
        Arc::new(move |dir| {
            let git = git.clone();
            Box::pin(async move { eos_core::git::GitInfo::git_dirs(git.as_ref(), &dir).await })
        })
    };
    let kernel = Kernel::new(KernelOptions::default());
    let dirs = Arc::new(DirWatcher::new(clock.clone(), fs_change_sink(kernel.bus.clone())));
    let repos = Arc::new(RepoWatcher::new(resolve, clock.clone(), git_change_sink(kernel.bus.clone()), true));
    let candidates = Arc::new(CandidateCache::new(git.clone(), clock.clone()));
    let pdfjs = root.join("pdfjs");
    fs::create_dir_all(pdfjs.join("web")).expect("the viewer folder");
    fs::write(pdfjs.join("web/viewer.html"), "<html>viewer</html>").expect("the viewer");
    let module = FsModule::new(
        kernel.clone(),
        Ports {
            files: Arc::new(eos_fs::DiskFileSystem::new(host, root.join(".eos-trash"))),
            desktop: Arc::new(eos_fs::DesktopApps::new(host, clock, root.join("icon-cache"))),
            picker: None,
            file_watcher: dirs.clone(),
            git: git.clone(),
            git_diffs: git.clone(),
            tree: git.clone(),
            branches: git.clone(),
            remotes: git,
            git_watcher: repos.clone(),
            symbols: Some(Arc::new(eos_symbols::TagIndex::new(candidates.clone()))),
            candidates,
            pdfjs_root: Some(pdfjs),
        },
    );
    let raw = Router::builder().routes(module.raw_routes()).build().expect("raw routes");
    let runtime = Runtime::build(kernel, vec![Arc::new(module)], Arc::new(AllPluginsOn)).expect("composes");
    App { _keep: keep, root, runtime, raw, dirs, repos }
}

impl App {
    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }

    fn write(&self, name: &str, content: impl AsRef<[u8]>) {
        let file = self.root.join(name);
        fs::create_dir_all(file.parent().expect("a parent")).expect("the folders");
        fs::write(file, content).expect("the file");
    }

    async fn send(&self, req: Request) -> (u16, Response) {
        let res = self.runtime.router.handle(req).await;
        (res.status, res)
    }

    async fn get(&self, target: &str) -> (u16, Value) {
        let (status, res) = self.send(Request::new(Method::Get, target, Caller::UNTRUSTED)).await;
        (status, body_json(res).await)
    }

    /// A POST from the user's dashboard.
    async fn post(&self, target: &str, body: Value) -> (u16, Value) {
        self.post_as(Caller::DASHBOARD, target, body).await
    }

    async fn post_as(&self, caller: Caller, target: &str, body: Value) -> (u16, Value) {
        let (status, res) = self.send(Request::new(Method::Post, target, caller).body(body.to_string())).await;
        (status, body_json(res).await)
    }

    async fn raw(&self, target: &str, range: Option<&str>) -> Response {
        let mut req = Request::new(Method::Get, target, Caller::UNTRUSTED);
        if let Some(range) = range {
            req = req.header("range", range);
        }
        self.raw.handle(req).await
    }
}

async fn bytes(res: Response) -> Vec<u8> {
    res.body.collect().await.expect("a body").to_vec()
}

async fn body_json(res: Response) -> Value {
    serde_json::from_slice(&bytes(res).await).unwrap_or(Value::Null)
}

fn query(pairs: &[(&str, &str)]) -> String {
    let encode = |s: &str| s.bytes().map(|b| format!("%{b:02X}")).collect::<String>();
    pairs.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect::<Vec<_>>().join("&")
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A repository on branch `trunk` (so no usual base branch exists) with one commit.
fn repo(app: &App) -> PathBuf {
    let dir = app.root.join("repo");
    fs::create_dir(&dir).expect("the repository folder");
    git(&dir, &["init", "-q", "-b", "trunk"]);
    for (key, value) in [("user.email", "t@t.t"), ("user.name", "t"), ("commit.gpgsign", "false")] {
        git(&dir, &["config", key, value]);
    }
    app.write("repo/a.txt", "one\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_is_checked_before_the_caller_is_asked_for() {
    let app = app();
    app.write("p/a.txt", "x");
    let root = app.path("p");
    // A malformed request is told so to anyone; a well-formed one needs the user.
    let (status, body) = app.post_as(Caller::UNTRUSTED, "/fs/create", json!({ "root": root })).await;
    assert_eq!((status, body["error"].as_str().is_some_and(|e| e.starts_with("invalid request: "))), (400, true));
    let relative = json!({ "root": "p", "path": "b.txt", "type": "file" });
    assert_eq!(
        app.post_as(Caller::UNTRUSTED, "/fs/create", relative).await,
        (400, json!({ "error": "cwd must be absolute" }))
    );
    for (route, body) in [
        ("/fs/create", json!({ "root": root, "path": "b.txt", "type": "file" })),
        ("/fs/trash", json!({ "root": root, "paths": ["a.txt"] })),
        ("/fs/write", json!({ "path": app.path("p/a.txt"), "content": "y" })),
        ("/fs/stash/apply", json!({ "cwd": root, "index": 0 })),
        ("/fs/open-in", json!({ "path": app.path("p/a.txt"), "target": "finder" })),
        ("/fs/git/unwatch", json!({ "dir": root, "clientId": "tab" })),
    ] {
        let refused = app.post_as(Caller::UNTRUSTED, route, body).await;
        assert_eq!(refused, (403, json!({ "error": "ui token required" })), "{route}");
    }
    // A dialog on the user's screen is theirs to raise: any other local caller is refused.
    for route in ["/pick-directory", "/pick-file"] {
        assert_eq!(app.get(route).await, (403, json!({ "error": "ui token required" })), "{route}");
    }
    // Without a shell there is no open panel.
    for (route, error) in
        [("/pick-directory", "no directory picker on this system"), ("/pick-file", "no file picker on this system")]
    {
        let (status, res) = app.send(Request::new(Method::Get, route, Caller::DASHBOARD)).await;
        assert_eq!((status, body_json(res).await), (501, json!({ "error": error })), "{route}");
    }
    assert_eq!(fs::read_to_string(app.root.join("p/a.txt")).expect("untouched"), "x");
    assert!(!app.root.join("p/b.txt").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn trashing_reports_each_path_and_keeps_what_it_removed() {
    let app = app();
    app.write("p/a.txt", "kept");
    app.write("p/sub/b.txt", "kept too");
    let body = json!({ "root": app.path("p"), "paths": ["a.txt", "../outside.txt", "missing.txt", "sub"] });
    let (status, answer) = app.post("/fs/trash", body).await;
    assert_eq!(status, 200);
    assert_eq!((answer["ok"].clone(), answer["trashed"].clone()), (json!(false), json!(["a.txt", "sub"])));
    assert_eq!(answer["failed"][0], json!({ "path": "../outside.txt", "error": "path escapes root" }));
    assert_eq!(answer["failed"][1]["path"], "missing.txt");
    assert!(!app.root.join("p/a.txt").exists() && !app.root.join("p/sub").exists());
    let kept: Vec<_> = fs::read_dir(app.root.join(".eos-trash")).expect("the fallback trash").collect();
    assert_eq!(kept.len(), 2, "what was trashed can be put back by hand");
}

#[tokio::test(flavor = "multi_thread")]
async fn moves_refuse_a_folder_into_itself_and_report_per_path() {
    let app = app();
    app.write("p/dir/inner/x.txt", "x");
    app.write("p/a.txt", "a");
    app.write("p/dest/a.txt", "old");
    let root = app.path("p");
    let moved =
        app.post("/fs/move", json!({ "root": root, "paths": ["dir", "a.txt"], "destDir": "dir/inner" })).await.1;
    assert_eq!(moved["results"][0], json!({ "from": "dir", "ok": false, "error": "cannot move a folder into itself" }));
    assert_eq!(moved["results"][1], json!({ "from": "a.txt", "ok": true }));
    assert!(app.root.join("p/dir/inner/a.txt").exists());

    app.write("p/a.txt", "new");
    let clash = app.post("/fs/move", json!({ "root": root, "paths": ["a.txt"], "destDir": "dest" })).await.1;
    assert_eq!(clash["ok"], false);
    assert_eq!(clash["results"][0]["error"], format!("already exists: {}", app.path("p/dest/a.txt")));
    let over = json!({ "root": root, "paths": ["a.txt"], "destDir": "dest", "overwrite": true });
    assert_eq!(app.post("/fs/move", over).await.1["ok"], true);
    assert_eq!(fs::read_to_string(app.root.join("p/dest/a.txt")).expect("moved"), "new");
    let escape = app.post("/fs/move", json!({ "root": root, "paths": ["a.txt"], "destDir": "../elsewhere" })).await;
    assert_eq!(escape, (400, json!({ "error": "destDir escapes root" })));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pasted_file_keeps_its_decoded_name_inside_its_own_folder() {
    let app = app();
    let paste = |name: &str| {
        Request::new(Method::Post, "/fs/paste", Caller::DASHBOARD)
            .header("content-type", "application/octet-stream")
            .header("x-filename", name)
            .body("bytes")
    };
    for (sent, saved) in [("%C3%A7ay%20%C3%B6.png", "çay ö.png"), ("100%.png", "100%.png"), ("..%2F..%2Fx", ".._.._x")]
    {
        let (status, res) = app.send(paste(sent)).await;
        let path = PathBuf::from(body_json(res).await["path"].as_str().expect("a path"));
        assert_eq!((status, path.file_name().and_then(|n| n.to_str())), (200, Some(saved)), "{sent}");
        assert_eq!(fs::read(&path).expect("saved"), b"bytes");
        fs::remove_dir_all(path.parent().expect("its folder")).expect("cleanup");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_image_is_revalidated_by_its_size_and_time() {
    let app = app();
    app.write("p/pixel.png", [0x89, b'P', b'N', b'G']);
    let target = format!("/fs/image?{}", query(&[("path", &app.path("p/pixel.png"))]));
    let (status, first) = app.send(Request::new(Method::Get, &target, Caller::UNTRUSTED)).await;
    let etag = first.header_value("etag").expect("tagged").to_owned();
    assert_eq!(
        (status, first.header_value("content-type"), first.header_value("cache-control")),
        (200, Some("image/png"), Some("no-cache"))
    );
    assert!(etag.starts_with("\"4-") && etag.ends_with('"'), "{etag}");
    assert_eq!(bytes(first).await, [0x89, b'P', b'N', b'G']);

    let again = Request::new(Method::Get, &target, Caller::UNTRUSTED).header("if-none-match", &etag);
    let (status, unchanged) = app.send(again).await;
    assert_eq!((status, unchanged.header_value("etag")), (304, Some(etag.as_str())));
    assert!(bytes(unchanged).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_raw_origin_serves_files_with_ranges_and_the_viewer_only() {
    let app = app();
    app.write("p/a b.html", "<p>0123456789</p>");
    let target = format!("/fs/raw{}", app.path("p/a%20b.html"));
    let whole = app.raw(&target, None).await;
    assert_eq!((whole.status, whole.header_value("content-type")), (200, Some("text/html; charset=utf-8")));
    assert_eq!(
        (whole.header_value("accept-ranges"), whole.header_value("content-length")),
        (Some("bytes"), Some("17"))
    );
    assert_eq!(bytes(whole).await, b"<p>0123456789</p>");

    let part = app.raw(&target, Some("bytes=3-6")).await;
    assert_eq!(
        (part.status, part.header_value("content-range"), part.header_value("content-length")),
        (206, Some("bytes 3-6/17"), Some("4"))
    );
    assert_eq!(bytes(part).await, b"0123");

    // A large file arrives whole, in pieces.
    app.write("p/big.bin", vec![7u8; 300_000]);
    assert_eq!(bytes(app.raw(&format!("/fs/raw{}", app.path("p/big.bin")), None).await).await.len(), 300_000);

    for (target, status, error) in [
        (format!("/fs/raw{}", app.path("p/missing.txt")), 404, "not found"),
        (format!("/fs/raw{}", app.path("p")), 404, "not a file"),
        ("/fs/raw/%E0%A4%A".to_owned(), 400, "bad path encoding"),
        ("/pdfjs/web/nope.js".to_owned(), 404, "not found"),
        ("/pdfjs/web/..%2F..%2Fp%2Fbig.bin".to_owned(), 404, "not found"),
    ] {
        let res = app.raw(&target, None).await;
        assert_eq!((res.status, body_json(res).await), (status, json!({ "error": error })), "{target}");
    }
    for viewer in ["/pdfjs", "/pdfjs/", "/pdfjs/web/viewer.html"] {
        assert_eq!(bytes(app.raw(viewer, None).await).await, b"<html>viewer</html>", "{viewer}");
    }
    // The raw routes are not on the API router, and the API routes not on the raw one.
    assert_eq!(app.get(&target).await.0, 404);
    assert_eq!(app.raw("/fs/stat?path=/", None).await.status, 404);
}

/// Reads the stream until a frame names `reason`.
async fn frame(stream: &mut eos_runtime::http::BodyStream, reason: &str) -> String {
    let wanted = format!("\"reason\":\"{reason}\"");
    let reading = async {
        let mut seen = String::new();
        while let Some(Ok(chunk)) = stream.next().await {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if let Some(line) = seen.lines().find(|line| line.contains(&wanted)) {
                return line.to_owned();
            }
        }
        panic!("the stream ended without {reason}: {seen}");
    };
    tokio::time::timeout(Duration::from_secs(10), reading).await.unwrap_or_else(|_| panic!("no {reason} frame arrived"))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tabs_watches_send_changes_and_end_with_its_stream() {
    let app = app();
    let dir = repo(&app);
    let dir_text = dir.to_string_lossy().into_owned();
    let options = AttachOptions { client_id: Some("tab-1".into()), ..AttachOptions::default() };
    let eos_runtime::http::Body::Stream(mut stream) = app.runtime.kernel.stream.attach(options).expect("a stream")
    else {
        panic!("the stream is a stream");
    };

    let watch = json!({ "root": dir_text, "dir": dir_text, "clientId": "tab-1" });
    assert_eq!(app.post("/fs/watch", watch.clone()).await, (200, json!({ "ok": true })));
    assert_eq!(app.post("/fs/watch", watch).await.0, 200, "watching again is harmless");
    let outside = json!({ "root": dir_text, "dir": "../", "clientId": "tab-1" });
    assert_eq!(app.post("/fs/watch", outside).await, (400, json!({ "error": "dir escapes root" })));
    assert_eq!(app.dirs.watched(), 1);
    app.write("repo/new.txt", "n");
    let change = frame(&mut stream, "fs:change").await;
    assert!(change.contains("\"kind\":\"add\"") && change.contains("new.txt"), "{change}");

    // The git watch starts once git has named the repository's folders.
    assert_eq!(app.post("/fs/git/watch", json!({ "dir": dir_text, "clientId": "tab-1" })).await.0, 200);
    for _ in 0..2000 {
        if app.repos.targets() == 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(app.repos.targets(), 3);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "empty"]);
    assert!(frame(&mut stream, "git:change").await.contains(&format!("\"dir\":\"{dir_text}\"")));

    // Another tab on the same folder keeps it watched when the first goes.
    let other = json!({ "root": dir_text, "dir": dir_text, "clientId": "tab-2" });
    assert_eq!(app.post("/fs/watch", other).await.0, 200);
    drop(stream);
    for _ in 0..2000 {
        if app.repos.targets() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!((app.repos.targets(), app.dirs.watched()), (0, 1), "tab-1's watches went with its stream");
    assert_eq!(app.post("/fs/unwatch", json!({ "clientId": "tab-2", "all": true })).await.0, 200);
    assert_eq!(app.dirs.watched(), 0);
    // The module holds no lease of its own: a direct holder is unaffected by tabs.
    let lease = app.dirs.watch(&dir);
    assert_eq!(app.dirs.watched(), 1);
    drop(lease);
}

#[tokio::test(flavor = "multi_thread")]
async fn changes_come_per_scope_with_the_base_named_only_when_it_resolves() {
    let app = app();
    let dir = repo(&app);
    let cwd = dir.to_string_lossy().into_owned();
    app.write("repo/a.txt", "one\ntwo\n");
    git(&dir, &["commit", "-q", "-am", "second"]);
    let head = git(&dir, &["rev-parse", "--short", "HEAD"]);
    let first = git(&dir, &["rev-parse", "--short", "HEAD^"]);
    app.write("repo/a.txt", "one\ntwo\nthree\n");
    app.write("repo/new.txt", "fresh\n");
    let changes = |extra: &[(&str, &str)]| {
        let mut pairs = vec![("cwd", cwd.as_str())];
        pairs.extend_from_slice(extra);
        format!("/fs/changes?{}", query(&pairs))
    };

    // Uncommitted: against HEAD, no base label.
    let (status, plain) = app.get(&changes(&[("patches", "1")])).await;
    assert_eq!(status, 200);
    assert_eq!(
        (plain["baseLabel"].clone(), plain["baseSha"].clone(), plain["headSha"].clone()),
        (Value::Null, json!(head), Value::Null)
    );
    assert_eq!(
        (plain["headLabel"].clone(), plain["repoLabel"].clone(), plain["insertions"].clone()),
        (json!("trunk"), json!("repo"), json!(1))
    );
    assert_eq!(plain["files"][0]["path"], "a.txt");
    assert!(plain["files"][0]["patch"].as_str().is_some_and(|p| p.contains("\n+three\n")));
    assert_eq!(
        (plain["files"][1]["path"].clone(), plain["files"][1]["untracked"].clone()),
        (json!("new.txt"), json!(true))
    );
    assert_eq!(plain["files"][1].get("patch"), None, "an untracked file is asked for on its own");

    // `auto` finds no usual base here (no remote, no main or master): a plain HEAD comparison.
    let auto = app.get(&changes(&[("base", "auto")])).await.1;
    assert_eq!(
        (auto["baseLabel"].clone(), auto["baseSha"].clone(), auto["insertions"].clone()),
        (Value::Null, json!(head), json!(1))
    );
    // A named base that resolves: everything since the fork point.
    git(&dir, &["branch", "old", "HEAD^"]);
    let based = app.get(&changes(&[("base", "old")])).await.1;
    assert_eq!(
        (based["baseLabel"].clone(), based["baseSha"].clone(), based["insertions"].clone()),
        (json!("old"), json!(first), json!(2))
    );
    assert_eq!(app.get(&changes(&[("base", "no-such-branch")])).await.1["baseLabel"], Value::Null);
    let bad = app.get(&changes(&[("base", "a..b")])).await;
    assert_eq!(bad, (400, json!({ "error": "invalid request: base: invalid ref" })));

    // One commit: its own files against its parent.
    let commit = app.get(&changes(&[("sha", &head), ("patches", "1")])).await.1;
    assert_eq!(
        (commit["baseSha"].clone(), commit["headSha"].clone(), commit["headLabel"].clone()),
        (json!(first), json!(head), json!(head))
    );
    assert_eq!((commit["files"][0]["untracked"].clone(), commit["insertions"].clone()), (json!(false), json!(1)));
    assert!(commit["files"][0]["patch"].as_str().is_some_and(|p| p.contains("\n+two\n")));
    assert_eq!(app.get(&changes(&[("sha", "deadbeef")])).await, (404, json!({ "error": "commit not found" })));

    // A stash is a commit too, shown against the HEAD it was made on.
    git(&dir, &["stash", "push", "-q", "-m", "wip"]);
    let stash = app.get(&format!("/fs/stashes?{}", query(&[("cwd", &cwd)]))).await.1["stashes"][0].clone();
    assert_eq!((stash["index"].clone(), stash["branch"].clone()), (json!(0), json!("trunk")));
    let stashed = app.get(&changes(&[("sha", stash["sha"].as_str().expect("a sha")), ("patches", "1")])).await.1;
    assert_eq!(stashed["baseSha"], json!(head));
    assert!(stashed["files"][0]["patch"].as_str().is_some_and(|p| p.contains("\n+three\n")));
    let one = [("cwd", cwd.as_str()), ("path", "a.txt"), ("sha", stash["sha"].as_str().expect("a sha"))];
    let file = app.get(&format!("/fs/changes/file?{}", query(&one))).await.1;
    assert!(file["patch"].as_str().is_some_and(|p| p.contains("\n+three\n")) && file["binary"] == false);
}

#[tokio::test(flavor = "multi_thread")]
async fn branch_names_are_checked_before_git_is_asked() {
    let app = app();
    let dir = repo(&app);
    let cwd = dir.to_string_lossy().into_owned();
    let create = |name: &str| app.post("/fs/branch/create", json!({ "cwd": cwd, "name": name }));
    assert_eq!(
        create("has space").await.1,
        json!({ "ok": false, "error": "Contains a forbidden character (space or one of ~ ^ : ? * [ \\)." })
    );
    assert_eq!(create("  feature/x  ").await.1, json!({ "ok": true, "branch": "feature/x" }));
    assert_eq!(git(&dir, &["branch", "--show-current"]), "feature/x", "created and switched to");
    let rename = app.post("/fs/branch/rename", json!({ "cwd": cwd, "from": "feature/x", "to": "a..b" })).await.1;
    assert_eq!(rename, json!({ "ok": false, "error": "Cannot contain '..'." }));

    // A switch blocked by local changes says so, and stashing lets it through.
    app.write("repo/a.txt", "on feature\n");
    git(&dir, &["commit", "-q", "-am", "feature"]);
    git(&dir, &["checkout", "-q", "trunk"]);
    app.write("repo/a.txt", "dirty\n");
    let checkout = |stash: bool| app.post("/fs/checkout", json!({ "cwd": cwd, "branch": "feature/x", "stash": stash }));
    assert_eq!(checkout(false).await.1, json!({ "ok": false, "dirty": true }));
    assert_eq!(checkout(true).await.1, json!({ "ok": true }));
    let branches = app.get(&format!("/fs/branches?{}&remotes=1", query(&[("cwd", &cwd)]))).await.1;
    assert_eq!((branches["current"].clone(), branches["stash"].clone()), (json!("feature/x"), json!(1)));
    assert_eq!(branches["branches"], json!(["feature/x", "trunk"]), "most recently checked out first");
    assert_eq!((branches["remotes"].clone(), branches["isGit"].clone()), (json!([]), json!(true)));
}

#[tokio::test(flavor = "multi_thread")]
async fn symbols_are_found_through_the_routes() {
    let app = app();
    app.write("p/src/parser.js", "export function parse(text) {\n  return text.split(\",\");\n}\n");
    app.write("p/src/cli.js", "import { parse } from \"./parser.js\";\n\nconsole.log(parse(\"a\"));\n");
    let root = app.path("p");
    let lookup = app.get(&format!("/symbols/lookup?{}", query(&[("root", &root), ("name", "parse")]))).await.1;
    assert_eq!(lookup["occurrences"].as_array().map(Vec::len), Some(1));
    assert_eq!(lookup["occurrences"][0]["lineText"], "export function parse(text) {");
    let refs = [("root", root.as_str()), ("name", "parse"), ("want", "references")];
    let references = app.get(&format!("/symbols/lookup?{}", query(&refs))).await.1;
    assert_eq!(references["occurrences"].as_array().map(Vec::len), Some(2));
    let outline = app.get(&format!("/symbols/file?{}", query(&[("root", &root), ("path", "src/parser.js")]))).await.1;
    assert_eq!(outline["occurrences"][0]["name"], "parse");
    let escape = app.get(&format!("/symbols/file?{}", query(&[("root", &root), ("path", "../x.js")]))).await;
    assert_eq!(escape, (400, json!({ "error": "path must resolve within root" })));
    let search = app.get(&format!("/symbols/search?{}", query(&[("root", &root), ("query", "par")]))).await.1;
    assert_eq!(search["symbols"][0]["name"], "parse");
    assert_eq!(app.get(&format!("/symbols/search?{}", query(&[("root", &root)]))).await.1, json!({ "symbols": [] }));
    assert_eq!(app.get("/symbols/lookup").await, (400, json!({ "error": "root must be absolute" })));

    // A new file is found once the project's list is stale: file search lists it anew.
    let list = format!("/fs/list?{}", query(&[("cwd", &root), ("query", "extra")]));
    assert_eq!(app.get(&list).await.1, json!({ "entries": [] }));
}
