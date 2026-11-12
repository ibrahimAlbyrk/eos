//! `infra/src/__tests__/FsTransferEndpoint.test.ts`, on temporary folders.
//! "Replace" goes to a fake Trash that records what it was handed.

#![allow(clippy::unwrap_used)]

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use bytes::Bytes;
use eos_contracts::{
    ManifestItem, ManifestItemType, Num, TransferCommitRequest, TransferCommitResult, TransferDecision,
    TransferErrorCode as Code, TransferId, TransferManifest, TransferPrepareRequest, TransferPrepareResult,
};
use eos_core::BoxFuture;
use eos_core::git::ProjectKeys;
use eos_core::net::transfer::{ByteRange, FileStamp, TransferEndpoint, WriteAt};
use eos_domain::transfer::TransferError;
use eos_testkit::FakeClock;
use eos_transfer_fs::{FsTransferEndpoint, FsTransferEndpointDeps, STAGING_DIR};
use indexmap::IndexMap;

const ID: &str = "tr-abcdef123456";

struct PathKeys;

impl ProjectKeys for PathKeys {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String> {
        let key = if path.ends_with("/repo") { "git:github.com/o/repo".to_owned() } else { format!("path:{path}") };
        Box::pin(std::future::ready(key))
    }
    fn to_path<'a>(&'a self, _key: &'a str, hint: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(hint.to_owned()))
    }
    fn find_path<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready((key == "git:github.com/o/repo").then(|| "/here/repo".to_owned())))
    }
}

struct Bench {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    src: PathBuf,
    dest: PathBuf,
    eos_home: PathBuf,
    trashed: Arc<Mutex<Vec<PathBuf>>>,
    clock: Arc<FakeClock>,
    ep: FsTransferEndpoint,
}

fn endpoint(
    root: &Path,
    eos_home: &Path,
    trashed: &Arc<Mutex<Vec<PathBuf>>>,
    clock: &Arc<FakeClock>,
) -> FsTransferEndpoint {
    let trashed = trashed.clone();
    FsTransferEndpoint::new(FsTransferEndpointDeps {
        home: root.to_owned(),
        forbidden: vec![eos_home.to_owned()],
        trash: Arc::new(move |path| {
            trashed.lock().unwrap().push(path.to_owned());
            if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(|e| e.to_string())
        }),
        projects: Arc::new(PathKeys),
        clock: clock.clone(),
    })
}

fn bench() -> Bench {
    let tmp = tempfile::tempdir().unwrap();
    // As the system names it (/var → /private/var), so paths compare as text.
    let root = fs::canonicalize(tmp.path()).unwrap();
    let (src, dest, eos_home) = (root.join("src"), root.join("dest"), root.join(".eos"));
    fs::create_dir(&src).unwrap();
    fs::create_dir(&eos_home).unwrap();
    let trashed = Arc::new(Mutex::new(Vec::new()));
    let clock = Arc::new(FakeClock::new());
    let ep = endpoint(&root, &eos_home, &trashed, &clock);
    Bench { _tmp: tmp, root, src, dest, eos_home, trashed, clock, ep }
}

fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn set_mtime(path: &Path, secs: u64) {
    fs::File::options().write(true).open(path).unwrap().set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
}

fn stamp(item: &ManifestItem) -> FileStamp {
    FileStamp { size: item.size as u64, mtime_ms: item.mtime_ms.as_f64() }
}

fn at(rel: &str, offset: u64, dest: &Path) -> WriteAt {
    WriteAt { id: ID.into(), dest_dir: s(dest), rel: rel.into(), offset }
}

fn code(result: Result<impl std::fmt::Debug, TransferError>) -> Option<Code> {
    result.unwrap_err().code
}

impl Bench {
    fn prepare_request(&self, items: Vec<ManifestItem>) -> TransferPrepareRequest {
        TransferPrepareRequest { id: TransferId(ID.into()), dest_dir: s(&self.dest), items }
    }

    fn commit_request(&self, decisions: &[(&str, TransferDecision)]) -> TransferCommitRequest {
        let decisions: IndexMap<String, TransferDecision> =
            decisions.iter().map(|(n, d)| ((*n).to_owned(), *d)).collect();
        TransferCommitRequest { id: TransferId(ID.into()), dest_dir: s(&self.dest), decisions }
    }

    /// An app bundle in miniature: nested folders, an executable, a framework link.
    fn make_app(&self) -> PathBuf {
        let app = self.src.join("Game.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::create_dir_all(app.join("Contents/Frameworks/X.framework/Versions/A")).unwrap();
        fs::write(app.join("Contents/MacOS/Game"), "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(app.join("Contents/MacOS/Game"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(app.join("Contents/Info.plist"), "<plist/>").unwrap();
        fs::write(app.join("Contents/Frameworks/X.framework/Versions/A/X"), "lib").unwrap();
        symlink("A", app.join("Contents/Frameworks/X.framework/Versions/Current")).unwrap();
        fs::write(app.join("Contents/empty"), "").unwrap();
        set_mtime(&app.join("Contents/Info.plist"), 1_600_000_000);
        app
    }

    /// Scans, stages five bytes at a time and commits.
    async fn copy(
        &self,
        paths: &[PathBuf],
        decisions: &[(&str, TransferDecision)],
    ) -> Result<(TransferManifest, TransferPrepareResult, TransferCommitResult), TransferError> {
        let picked: Vec<String> = paths.iter().map(|p| s(p)).collect();
        let manifest = self.ep.scan(&picked).await?;
        let prep = self.ep.prepare(&self.prepare_request(manifest.items.clone())).await?;
        for file in manifest.items.iter().filter(|i| i.r#type == ManifestItemType::File && i.size > 0) {
            let root = file.rel.split('/').next().unwrap();
            let parent = paths.iter().find(|p| p.ends_with(root)).unwrap().parent().unwrap();
            let mut offset = prep.staged.get(&file.rel).copied().unwrap_or(0) as u64;
            while offset < file.size as u64 {
                let length = 5.min(file.size as u64 - offset);
                let bytes =
                    self.ep.read(&s(&parent.join(&file.rel)), ByteRange { offset, length }, stamp(file)).await?;
                offset = self.ep.write(&at(&file.rel, offset, &self.dest), bytes).await?;
            }
        }
        let result = self.ep.commit(&self.commit_request(decisions)).await?;
        Ok((manifest, prep, result))
    }
}

#[tokio::test]
async fn lists_a_folder_folders_first_sizes_on_files_staging_and_dotfiles_hidden() {
    let b = bench();
    fs::create_dir(b.src.join("b-dir")).unwrap();
    fs::write(b.src.join("a.txt"), "12345").unwrap();
    fs::write(b.src.join("file10.txt"), "").unwrap();
    fs::write(b.src.join("file2.txt"), "").unwrap();
    fs::write(b.src.join(".secret"), "x").unwrap();
    fs::write(b.src.join(".DS_Store"), "x").unwrap();
    fs::create_dir(b.src.join(STAGING_DIR)).unwrap();
    symlink(b.src.join("b-dir"), b.src.join("z-link")).unwrap();
    let listing = b.ep.list(&s(&b.src), false).await.unwrap();
    let rows: Vec<(&str, &str, Option<i64>, bool)> = listing
        .entries
        .iter()
        .map(|e| (e.name.as_str(), if e.path.ends_with(&e.name) { "ok" } else { "bad path" }, e.size, e.is_symlink))
        .collect();
    assert_eq!(
        rows,
        [
            ("b-dir", "ok", None, false),
            ("z-link", "ok", None, true),
            ("a.txt", "ok", Some(5), false),
            ("file2.txt", "ok", Some(0), false),
            ("file10.txt", "ok", Some(0), false),
        ]
    );
    assert_eq!(listing.parent.as_deref(), Some(s(&b.root).as_str()));
    assert_eq!(listing.home, s(&b.root));
    assert_eq!(listing.path, s(&b.src));
    let hidden = b.ep.list(&s(&b.src), true).await.unwrap();
    assert!(hidden.entries.iter().any(|e| e.name == ".secret"));
    assert!(!hidden.entries.iter().any(|e| e.name == ".DS_Store" || e.name == STAGING_DIR));
    assert_eq!(b.ep.list("/", false).await.unwrap().parent, None);

    assert_eq!(code(b.ep.list(&s(&b.src.join("nope")), false).await), Some(Code::NotFound));
    assert_eq!(code(b.ep.list(&s(&b.src.join("a.txt")), false).await), Some(Code::BadPath));
    assert_eq!(b.ep.list("src", false).await.unwrap_err().message, "an absolute path is required");
}

#[tokio::test]
async fn copies_an_app_bundle_whole_tree_executable_bit_link_empty_file_mtimes() {
    let b = bench();
    let app = b.make_app();
    let (manifest, _, result) = b.copy(&[app], &[]).await.unwrap();
    assert_eq!(manifest.roots.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["Game.app"]);
    // Children in name order, depth first; a link carries its target and no size.
    let rels: Vec<&str> = manifest.items.iter().map(|i| i.rel.as_str()).collect();
    assert_eq!(
        rels,
        [
            "Game.app",
            "Game.app/Contents",
            "Game.app/Contents/Frameworks",
            "Game.app/Contents/Frameworks/X.framework",
            "Game.app/Contents/Frameworks/X.framework/Versions",
            "Game.app/Contents/Frameworks/X.framework/Versions/A",
            "Game.app/Contents/Frameworks/X.framework/Versions/A/X",
            "Game.app/Contents/Frameworks/X.framework/Versions/Current",
            "Game.app/Contents/Info.plist",
            "Game.app/Contents/MacOS",
            "Game.app/Contents/MacOS/Game",
            "Game.app/Contents/empty",
        ]
    );
    let link = &manifest.items[7];
    assert_eq!((link.r#type, link.target.as_deref(), link.size), (ManifestItemType::Link, Some("A"), 0));
    assert_eq!((manifest.file_count, manifest.total_bytes), (4, 18 + 8 + 3));

    assert_eq!(result.placed.len(), 1);
    assert_eq!(
        (result.placed[0].name.as_str(), result.placed[0].path.as_str()),
        ("Game.app", s(&b.dest.join("Game.app")).as_str())
    );
    let out = b.dest.join("Game.app/Contents");
    assert_eq!(fs::read_to_string(out.join("MacOS/Game")).unwrap(), "#!/bin/sh\necho hi\n");
    assert_eq!(fs::metadata(out.join("MacOS/Game")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(fs::read_link(out.join("Frameworks/X.framework/Versions/Current")).unwrap(), Path::new("A"));
    assert_eq!(fs::read_to_string(out.join("empty")).unwrap(), "");
    let placed_at = fs::metadata(out.join("Info.plist")).unwrap().modified().unwrap();
    assert_eq!(placed_at, UNIX_EPOCH + Duration::from_secs(1_600_000_000));
    assert!(!b.dest.join(STAGING_DIR).exists(), "staging cleaned up");
}

#[tokio::test]
async fn a_read_only_file_lands_read_only_and_its_last_chunk_can_be_sent_again() {
    let b = bench();
    let file = b.src.join("locked.txt");
    fs::write(&file, "abcdef").unwrap();
    set_mtime(&file, 1_650_000_000);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();
    let manifest = b.ep.scan(&[s(&file)]).await.unwrap();
    assert_eq!(manifest.items[0].mode, 0o444);
    b.ep.prepare(&b.prepare_request(manifest.items.clone())).await.unwrap();
    assert_eq!(b.ep.write(&at("locked.txt", 0, &b.dest), Bytes::from_static(b"abcdef")).await.unwrap(), 6);
    // The answer was lost and the chunk comes again: the file says what it holds.
    let again = b.ep.write(&at("locked.txt", 0, &b.dest), Bytes::from_static(b"abcdef")).await.unwrap_err();
    assert_eq!((again.code, again.have), (Some(Code::OffsetMismatch), Some(6)));
    // The source changed meanwhile: the staged copy starts over, read-only or not.
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    set_mtime(&file, 1_660_000_000);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();
    let changed = b.ep.scan(&[s(&file)]).await.unwrap();
    assert!(b.ep.prepare(&b.prepare_request(changed.items.clone())).await.unwrap().staged.is_empty());
    assert_eq!(b.ep.write(&at("locked.txt", 0, &b.dest), Bytes::from_static(b"abcdef")).await.unwrap(), 6);
    b.ep.commit(&b.commit_request(&[])).await.unwrap();
    let placed = fs::metadata(b.dest.join("locked.txt")).unwrap();
    assert_eq!(placed.permissions().mode() & 0o777, 0o444);
    assert_eq!(placed.modified().unwrap(), UNIX_EPOCH + Duration::from_secs(1_660_000_000));
}

#[tokio::test]
async fn refuses_a_source_that_changed_since_its_scan() {
    let b = bench();
    let file = b.src.join("f.txt");
    fs::write(&file, "before").unwrap();
    let manifest = b.ep.scan(&[s(&file)]).await.unwrap();
    let scanned = stamp(&manifest.items[0]);
    let range = ByteRange { offset: 0, length: 3 };
    assert_eq!(&b.ep.read(&s(&file), range, scanned).await.unwrap()[..], b"bef");
    assert_eq!(code(b.ep.read(&s(&file), ByteRange { offset: 4, length: 3 }, scanned).await), Some(Code::BadPath));
    assert_eq!(code(b.ep.read(&s(&file), ByteRange { offset: 0, length: 0 }, scanned).await), Some(Code::BadPath));
    fs::write(&file, "after!!").unwrap();
    let changed = b.ep.read(&s(&file), range, scanned).await.unwrap_err();
    assert_eq!(changed.code, Some(Code::SourceChanged));
    assert_eq!(changed.message, "f.txt changed while it was being copied — send it again");
    // Replaced by a link: never followed.
    fs::remove_file(&file).unwrap();
    symlink("/etc/hosts", &file).unwrap();
    let gone = b.ep.read(&s(&file), range, scanned).await.unwrap_err();
    assert_eq!(gone.message, "f.txt is gone or was replaced since it was picked");
}

#[tokio::test]
async fn only_appends_at_the_staged_size_and_says_what_it_holds() {
    let b = bench();
    fs::write(b.src.join("f.txt"), "abcdef").unwrap();
    let manifest = b.ep.scan(&[s(&b.src.join("f.txt"))]).await.unwrap();
    b.ep.prepare(&b.prepare_request(manifest.items)).await.unwrap();
    assert_eq!(b.ep.write(&at("f.txt", 0, &b.dest), Bytes::from_static(b"abc")).await.unwrap(), 3);
    let again = b.ep.write(&at("f.txt", 0, &b.dest), Bytes::from_static(b"abc")).await.unwrap_err();
    assert_eq!((again.code, again.have), (Some(Code::OffsetMismatch), Some(3)));
    assert_eq!(again.message, "f.txt holds 3 bytes, not 0");
    let more = b.ep.write(&at("f.txt", 3, &b.dest), Bytes::from_static(b"defg")).await;
    assert_eq!(code(more), Some(Code::BadPath), "never more than scanned");
    assert_eq!(code(b.ep.write(&at("other.txt", 0, &b.dest), Bytes::from_static(b"x")).await), Some(Code::BadPath));
    assert_eq!(code(b.ep.commit(&b.commit_request(&[])).await), Some(Code::Incomplete));
}

#[tokio::test]
async fn resumes_what_is_staged_but_restarts_a_file_that_changed_in_between() {
    let b = bench();
    let (a, c) = (b.src.join("a.txt"), b.src.join("b.txt"));
    fs::write(&a, "aaaa").unwrap();
    fs::write(&c, "bbbb").unwrap();
    let picked = [s(&a), s(&c)];
    let manifest = b.ep.scan(&picked).await.unwrap();
    b.ep.prepare(&b.prepare_request(manifest.items)).await.unwrap();
    b.ep.write(&at("a.txt", 0, &b.dest), Bytes::from_static(b"aa")).await.unwrap();
    b.ep.write(&at("b.txt", 0, &b.dest), Bytes::from_static(b"bb")).await.unwrap();
    set_mtime(&c, 1_700_000_000);
    let again = b.ep.scan(&picked).await.unwrap();
    // A fresh endpoint: what is staged is read back from disk, as after a restart.
    let restarted = endpoint(&b.root, &b.eos_home, &b.trashed, &b.clock);
    let prep = restarted.prepare(&b.prepare_request(again.items)).await.unwrap();
    assert_eq!(prep.staged.iter().collect::<Vec<_>>(), [(&"a.txt".to_owned(), &2)]);
    assert!(prep.free_bytes.as_f64() > 0.0);
    // And a write carries on where the staging stands, without a prepare.
    let later = endpoint(&b.root, &b.eos_home, &b.trashed, &b.clock);
    assert_eq!(later.write(&at("a.txt", 2, &b.dest), Bytes::from_static(b"aa")).await.unwrap(), 4);
    assert!(!b.dest.join(STAGING_DIR).join(ID).join("files/b.txt").exists(), "started over");
}

#[tokio::test]
async fn applies_each_decision_replace_to_the_trash_keep_both_renames_skip_leaves_it() {
    let b = bench();
    fs::create_dir(&b.dest).unwrap();
    let names = ["r.txt", "k.txt", "s.txt"];
    for name in names {
        fs::write(b.src.join(name), format!("new {name}")).unwrap();
        fs::write(b.dest.join(name), format!("old {name}")).unwrap();
    }
    let picked: Vec<PathBuf> = names.iter().map(|n| b.src.join(n)).collect();
    let manifest = b.ep.scan(&picked.iter().map(|p| s(p)).collect::<Vec<_>>()).await.unwrap();
    let prep = b.ep.prepare(&b.prepare_request(manifest.items)).await.unwrap();
    let mut existing: Vec<(&str, Option<i64>)> = prep.existing.iter().map(|e| (e.name.as_str(), e.size)).collect();
    existing.sort_unstable();
    assert_eq!(existing, [("k.txt", Some(9)), ("r.txt", Some(9)), ("s.txt", Some(9))]);
    assert_eq!(code(b.copy(&picked, &[]).await), Some(Code::ConflictUnresolved));
    assert!(b.trashed.lock().unwrap().is_empty(), "nothing moved before every conflict has a decision");

    use TransferDecision::{Keep, Replace, Skip};
    let (_, _, result) = b.copy(&picked, &[("r.txt", Replace), ("k.txt", Keep), ("s.txt", Skip)]).await.unwrap();
    assert_eq!(*b.trashed.lock().unwrap(), [b.dest.join("r.txt")]);
    assert_eq!(fs::read_to_string(b.dest.join("r.txt")).unwrap(), "new r.txt");
    assert_eq!(fs::read_to_string(b.dest.join("k.txt")).unwrap(), "old k.txt");
    assert_eq!(fs::read_to_string(b.dest.join("k 2.txt")).unwrap(), "new k.txt");
    assert_eq!(fs::read_to_string(b.dest.join("s.txt")).unwrap(), "old s.txt");
    assert_eq!(result.skipped, ["s.txt"]);
    let mut placed: Vec<&str> = result.placed.iter().map(|p| p.name.as_str()).collect();
    placed.sort_unstable();
    assert_eq!(placed, ["k 2.txt", "r.txt"]);
}

#[tokio::test]
async fn answers_a_repeated_commit_with_the_same_result_for_ten_minutes() {
    let b = bench();
    fs::write(b.src.join("f.txt"), "hi").unwrap();
    let (_, _, result) = b.copy(&[b.src.join("f.txt")], &[]).await.unwrap();
    assert_eq!(b.ep.commit(&b.commit_request(&[])).await.unwrap(), result);
    b.clock.advance(10 * 60_000 + 1);
    assert_eq!(code(b.ep.commit(&b.commit_request(&[])).await), Some(Code::NotFound), "forgotten: nothing is staged");
}

#[tokio::test]
async fn a_commit_that_stopped_half_way_carries_on_from_what_it_placed() {
    let b = bench();
    fs::create_dir(&b.dest).unwrap();
    fs::write(b.src.join("a.txt"), "a").unwrap();
    fs::write(b.src.join("b.txt"), "b").unwrap();
    fs::write(b.dest.join("b.txt"), "old").unwrap();
    let picked = [b.src.join("a.txt"), b.src.join("b.txt")];
    // "a.txt" lands, then "b.txt" has no decision yet.
    assert_eq!(code(b.copy(&picked, &[]).await), Some(Code::ConflictUnresolved));
    assert_eq!(fs::read_to_string(b.dest.join("a.txt")).unwrap(), "a");
    let stage = b.dest.join(STAGING_DIR).join(ID);
    assert_eq!(fs::read_to_string(stage.join("placed.json")).unwrap(), r#"[["a.txt","a.txt"]]"#);
    // The retry, after a restart: "a.txt" is not placed twice (no "a 2.txt"), "b.txt" follows its decision.
    let restarted = endpoint(&b.root, &b.eos_home, &b.trashed, &b.clock);
    let result = restarted.commit(&b.commit_request(&[("b.txt", TransferDecision::Keep)])).await.unwrap();
    let placed: Vec<&str> = result.placed.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(placed, ["a.txt", "b 2.txt"]);
    assert!(!b.dest.join(STAGING_DIR).exists());
}

#[tokio::test]
async fn never_lands_inside_eos_own_data_even_through_a_link() {
    let b = bench();
    fs::write(b.src.join("f.txt"), "hi").unwrap();
    let manifest = b.ep.scan(&[s(&b.src.join("f.txt"))]).await.unwrap();
    let into = |dest: PathBuf| TransferPrepareRequest {
        id: TransferId(ID.into()),
        dest_dir: s(&dest),
        items: manifest.items.clone(),
    };
    assert_eq!(code(b.ep.prepare(&into(b.eos_home.join("x"))).await), Some(Code::ForbiddenDest));
    assert_eq!(code(b.ep.prepare(&into(b.eos_home.clone())).await), Some(Code::ForbiddenDest));
    assert!(!b.eos_home.join("x").exists(), "refused before anything was created");
    symlink(&b.eos_home, b.root.join("sneaky")).unwrap();
    assert_eq!(code(b.ep.prepare(&into(b.root.join("sneaky"))).await), Some(Code::ForbiddenDest));
    assert_eq!(code(b.ep.prepare(&into(b.root.join("x/../.eos/y"))).await), Some(Code::ForbiddenDest));
    // A folder that only starts with the same letters is not Eos's.
    b.ep.prepare(&into(b.root.join(".eos-other"))).await.unwrap();
}

#[tokio::test]
async fn refuses_a_manifest_that_reaches_out_of_its_folder_and_an_id_that_is_not_one() {
    let b = bench();
    let item = |rel: &str| ManifestItem {
        rel: rel.into(),
        r#type: ManifestItemType::File,
        size: 1,
        mtime_ms: Num(0.0),
        mode: 0o644,
        target: None,
    };
    for rel in ["../escape.txt", "/etc/passwd", "a/../../b"] {
        assert_eq!(code(b.ep.prepare(&b.prepare_request(vec![item(rel)])).await), Some(Code::BadPath), "{rel}");
    }
    assert_eq!(code(b.ep.prepare(&b.prepare_request(vec![item("a"), item("a")])).await), Some(Code::BadPath));
    let mut link = item("l");
    link.r#type = ManifestItemType::Link;
    assert_eq!(code(b.ep.prepare(&b.prepare_request(vec![link])).await), Some(Code::BadPath));
    let mut elsewhere = b.prepare_request(vec![item("f")]);
    elsewhere.id = TransferId("../../outside".into());
    assert_eq!(code(b.ep.prepare(&elsewhere).await), Some(Code::BadPath));
    let mut bad = at("f", 0, &b.dest);
    bad.id = "../x".into();
    assert_eq!(code(b.ep.write(&bad, Bytes::from_static(b"x")).await), Some(Code::BadPath));
    assert!(!b.root.join("outside").exists());
}

#[tokio::test]
async fn never_writes_through_a_link_left_in_the_staging() {
    let b = bench();
    let outside = b.root.join("outside");
    fs::create_dir(&outside).unwrap();
    let item = |rel: &str, kind, size| ManifestItem {
        rel: rel.into(),
        r#type: kind,
        size,
        mtime_ms: Num(0.0),
        mode: if kind == ManifestItemType::Dir { 0o755 } else { 0o644 },
        target: None,
    };
    let items = vec![
        item("a", ManifestItemType::Dir, 0),
        item("a/b", ManifestItemType::Dir, 0),
        item("a/b/f", ManifestItemType::File, 2),
        item("a/g", ManifestItemType::File, 2),
    ];
    b.ep.prepare(&b.prepare_request(items)).await.unwrap();
    let staged = b.dest.join(STAGING_DIR).join(ID).join("files/a");
    fs::remove_dir_all(staged.join("b")).unwrap();
    symlink(&outside, staged.join("b")).unwrap();
    let through = b.ep.write(&at("a/b/f", 0, &b.dest), Bytes::from_static(b"hi")).await.unwrap_err();
    assert_eq!((through.code, through.message.as_str()), (Some(Code::BadPath), "that path leaves the staging folder"));
    assert!(!outside.join("f").exists());
    // Nor through a link standing where the file itself would be.
    symlink(outside.join("g"), staged.join("g")).unwrap();
    assert!(b.ep.write(&at("a/g", 0, &b.dest), Bytes::from_static(b"hi")).await.is_err());
    assert!(!outside.join("g").exists());
}

#[tokio::test]
async fn refuses_two_picked_items_with_the_same_name() {
    let b = bench();
    for dir in ["x", "y"] {
        fs::create_dir(b.src.join(dir)).unwrap();
        fs::write(b.src.join(dir).join("n.txt"), dir).unwrap();
    }
    let twice = b.ep.scan(&[s(&b.src.join("x/n.txt")), s(&b.src.join("y/n.txt"))]).await.unwrap_err();
    assert_eq!(twice.code, Some(Code::DuplicateName));
    assert_eq!(twice.message, "two picked items are both called \"n.txt\" — send them one at a time");
    assert_eq!(code(b.ep.scan(&[s(&b.src.join("nope"))]).await), Some(Code::NotFound));
}

#[tokio::test]
async fn drops_the_staging_on_abort() {
    let b = bench();
    fs::write(b.src.join("f.txt"), "hi").unwrap();
    let manifest = b.ep.scan(&[s(&b.src.join("f.txt"))]).await.unwrap();
    b.ep.prepare(&b.prepare_request(manifest.items)).await.unwrap();
    assert!(b.dest.join(STAGING_DIR).join(ID).is_dir());
    b.ep.abort(ID, &s(&b.dest)).await.unwrap();
    assert!(!b.dest.join(STAGING_DIR).exists());
    // Unknown transfers and folders that are not there abort quietly.
    b.ep.abort("tr-unknown00", &s(&b.dest)).await.unwrap();
    b.ep.abort(ID, &s(&b.root.join("nowhere"))).await.unwrap();
    assert_eq!(code(b.ep.write(&at("f.txt", 0, &b.dest), Bytes::from_static(b"hi")).await), Some(Code::NotFound));
}

#[tokio::test]
async fn a_project_travels_as_its_repository_key() {
    let b = bench();
    assert_eq!(b.ep.project_key("/work/repo").await.unwrap().as_deref(), Some("git:github.com/o/repo"));
    assert_eq!(b.ep.project_key("/work/loose").await.unwrap(), None, "a folder without a remote has no key");
    assert_eq!(b.ep.locate("git:github.com/o/repo").await.unwrap().as_deref(), Some("/here/repo"));
    assert_eq!(b.ep.locate("git:github.com/o/none").await.unwrap(), None);
    assert_eq!(b.ep.locate("path:/x").await.unwrap(), None);
    assert_eq!(b.ep.home().await.unwrap(), s(&b.root));
}
