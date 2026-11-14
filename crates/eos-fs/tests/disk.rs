//! The file system port on a throwaway folder. The generic host is used
//! throughout, so nothing ever reaches the real Trash.

use std::fs;
use std::path::{Path, PathBuf};

use eos_core::Error;
use eos_core::os::{FileRead, FileSystem, ListDirOptions};
use eos_fs::DiskFileSystem;

struct Sandbox {
    _keep: tempfile::TempDir,
    root: PathBuf,
    fs: DiskFileSystem,
}

fn sandbox() -> Sandbox {
    let keep = tempfile::tempdir().expect("dir");
    let root = fs::canonicalize(keep.path()).expect("real path");
    let fs = DiskFileSystem::new(eos_platform::generic_host(), root.join(".eos-trash"));
    Sandbox { _keep: keep, root, fs }
}

impl Sandbox {
    fn write(&self, name: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(&path, content).expect("write");
        path
    }

    fn options(&self) -> ListDirOptions<'_> {
        ListDirOptions { root: &self.root, include_hidden: false, apply_ignore: true }
    }
}

fn symlink(target: &Path, link: &Path) {
    assert!(std::process::Command::new("ln").arg("-s").arg(target).arg(link).status().expect("ln").success());
}

#[tokio::test]
async fn a_listing_puts_folders_first_and_hides_dot_and_ignored_names() {
    let s = sandbox();
    for file in ["README.md", "notes.txt", "src/a.js", "docs/x.md", ".env", "node_modules/p/i.js", "Zed.txt"] {
        s.write(file, "x");
    }
    let names = |entries: &[eos_core::os::FsEntryMeta]| entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>();
    let plain = s.fs.list_dir(&s.root, s.options()).await.expect("listing");
    assert_eq!(names(&plain), ["docs", "src", "notes.txt", "README.md", "Zed.txt"]);
    assert_eq!((plain[0].is_dir, plain[0].is_symlink, plain[0].relative_path.as_str()), (true, false, "docs"));
    assert_eq!(plain[2].absolute_path, s.root.join("notes.txt"));

    let hidden = s.fs.list_dir(&s.root, ListDirOptions { include_hidden: true, ..s.options() }).await.expect("listing");
    assert_eq!(names(&hidden), ["docs", "src", ".env", "notes.txt", "README.md", "Zed.txt"]);
    let everything = ListDirOptions { include_hidden: true, apply_ignore: false, ..s.options() };
    assert!(names(&s.fs.list_dir(&s.root, everything).await.expect("listing")).contains(&"node_modules".to_owned()));

    let sub = s.fs.list_dir(&s.root.join("src"), s.options()).await.expect("listing");
    assert_eq!(sub[0].relative_path, "src/a.js");

    let missing = s.fs.list_dir(&s.root.join("nope"), s.options()).await.expect_err("missing");
    assert_eq!(missing.to_string(), format!("path not found: {}", s.root.join("nope").display()));
}

#[tokio::test]
async fn links_are_followed_once_for_their_kind() {
    let s = sandbox();
    s.write("real/a.txt", "x");
    symlink(&s.root.join("real"), &s.root.join("to-folder"));
    symlink(&s.root.join("gone"), &s.root.join("broken"));
    let entries = s.fs.list_dir(&s.root, s.options()).await.expect("listing");
    let kind = |name: &str| entries.iter().find(|e| e.name == name).map(|e| (e.is_dir, e.is_symlink));
    assert_eq!(kind("to-folder"), Some((true, true)));
    assert_eq!(kind("broken"), Some((false, true)));
    assert_eq!(kind("real"), Some((true, false)));

    let linked = s.fs.stat(&s.root.join("to-folder")).await.expect("stat");
    assert!(linked.is_dir && linked.is_symlink);
    let broken = s.fs.stat(&s.root.join("broken")).await.expect("stat");
    assert!(!broken.is_dir && broken.is_symlink);
    assert!(!s.fs.exists(&s.root.join("broken")).await);
    assert!(s.fs.exists(&s.root.join("to-folder")).await);
}

#[tokio::test]
async fn stat_reports_size_time_and_write_access() {
    let s = sandbox();
    let file = s.write("notes.md", "# Notes\n\n- first\n- second\n");
    let stat = s.fs.stat(&file).await.expect("stat");
    assert_eq!((stat.is_dir, stat.size, stat.is_symlink, stat.readonly), (false, 26, false, false));
    assert!(stat.mtime_ms > 1_700_000_000_000.0);
    assert!(s.fs.stat(&s.root).await.expect("stat").is_dir);
    let missing = s.fs.stat(&s.root.join("nope.md")).await.expect_err("missing");
    assert_eq!(missing, Error::not_found("path", s.root.join("nope.md").display().to_string()));

    let mut perms = fs::metadata(&file).expect("meta").permissions();
    perms.set_readonly(true);
    fs::set_permissions(&file, perms).expect("chmod");
    assert!(s.fs.stat(&file).await.expect("stat").readonly);
}

#[tokio::test]
async fn reading_tells_text_from_binary_and_large() {
    let s = sandbox();
    let text = s.write("notes.md", "# Notes\n\n- first\n- second\n");
    assert_eq!(
        s.fs.read_text(&text, 1024).await,
        Ok(FileRead::Text { content: "# Notes\n\n- first\n- second\n".into(), lines: 5, size: 26 })
    );
    assert_eq!(
        s.fs.read_text(&s.write("empty.txt", ""), 1024).await,
        Ok(FileRead::Text { content: String::new(), lines: 1, size: 0 })
    );
    let binary = s.write("pixel.png", [0x89, b'P', b'N', b'G', 0, 1, 2]);
    assert_eq!(s.fs.read_text(&binary, 1024).await, Ok(FileRead::Binary { size: 7 }));
    let large = s.write("big.txt", "x".repeat(20_000));
    assert_eq!(s.fs.read_text(&large, 10_000).await, Ok(FileRead::Large { size: 20_000 }));
    assert!(matches!(s.fs.read_text(&large, 20_000).await, Ok(FileRead::Text { size: 20_000, lines: 1, .. })));

    // The failures in today's words (fixtures/wire/recordings/13-files.json).
    let missing = s.root.join("nope.md");
    assert_eq!(
        s.fs.read_text(&missing, 1024).await,
        Err(Error::Storage(format!("ENOENT: no such file or directory, open '{}'", missing.display())))
    );
    assert_eq!(
        s.fs.read_text(&s.root, 1024).await,
        Err(Error::Storage("EISDIR: illegal operation on a directory, read".into()))
    );
}

#[tokio::test]
async fn an_open_file_is_read_in_pieces() {
    let s = sandbox();
    let path = s.write("notes.md", "# Notes\n\n- first\n- second\n");
    let mut file = s.fs.open(&path).await.expect("open");
    assert!(file.is_file());
    assert_eq!(file.size(), 26);
    assert_eq!(file.read_at(2, 5).expect("read"), b"Notes");
    assert_eq!(file.read_at(20, 100).expect("read"), b"econd\n");
    assert!(file.read_at(26, 10).expect("read").is_empty());

    let mut folder = s.fs.open(&s.root).await.expect("a folder opens");
    assert!(!folder.is_file());
    assert_eq!(folder.read_at(0, 10), Err(Error::Storage("EISDIR: illegal operation on a directory, read".into())));
    let missing = s.root.join("nope.png");
    let Err(error) = s.fs.open(&missing).await else { panic!("a missing file opened") };
    assert_eq!(error, Error::Storage(format!("ENOENT: no such file or directory, stat '{}'", missing.display())));
}

#[tokio::test]
async fn writing_replaces_content_and_makes_folders_only_when_asked() {
    let s = sandbox();
    let file = s.root.join("written.md");
    s.fs.write_text(&file, "# Written\n", false).await.expect("write");
    s.fs.write_text(&file, "again\n", false).await.expect("write");
    assert_eq!(fs::read_to_string(&file).expect("read"), "again\n");

    let deep = s.root.join("deep/er/file.txt");
    assert_eq!(
        s.fs.write_text(&deep, "x", false).await,
        Err(Error::Storage(format!("ENOENT: no such file or directory, open '{}'", deep.display())))
    );
    s.fs.write_text(&deep, "nested\n", true).await.expect("write");
    assert_eq!(fs::read_to_string(&deep).expect("read"), "nested\n");
}

#[tokio::test]
async fn a_pasted_file_lands_in_its_own_temporary_folder() {
    let s = sandbox();
    let first = s.fs.write_temp("eos-paste-", "clip.txt", b"pasted bytes").await.expect("paste");
    let second = s.fs.write_temp("eos-paste-", "clip.txt", b"other").await.expect("paste");
    assert_ne!(first, second);
    assert_eq!(fs::read(&first).expect("read"), b"pasted bytes");
    let folder = first.parent().and_then(Path::file_name).and_then(|n| n.to_str()).expect("a folder name");
    assert!(folder.starts_with("eos-paste-") && folder.len() == "eos-paste-".len() + 6, "{folder}");
    assert_eq!(
        first.parent().and_then(Path::parent).map(fs::canonicalize).and_then(Result::ok),
        fs::canonicalize(std::env::temp_dir()).ok()
    );
    for path in [first, second] {
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }
}

#[tokio::test]
async fn creating_never_replaces_and_needs_the_folder_above() {
    let s = sandbox();
    let file = s.root.join("created.txt");
    s.fs.create_file(&file, "made\n").await.expect("create");
    assert_eq!(fs::read_to_string(&file).expect("read"), "made\n");
    assert_eq!(s.fs.create_file(&file, "").await, Err(Error::Conflict(format!("already exists: {}", file.display()))));
    let orphan = s.root.join("no/parent.txt");
    assert_eq!(s.fs.create_file(&orphan, "").await, Err(Error::not_found("path", orphan.display().to_string())));

    let folder = s.root.join("folder");
    s.fs.mkdir(&folder).await.expect("mkdir");
    assert_eq!(s.fs.mkdir(&folder).await, Err(Error::Conflict(format!("already exists: {}", folder.display()))));
    let deep = s.root.join("a/b");
    assert_eq!(s.fs.mkdir(&deep).await, Err(Error::not_found("path", deep.display().to_string())));
}

#[tokio::test]
async fn renaming_and_moving_refuse_to_replace_unless_told() {
    let s = sandbox();
    let (a, b) = (s.write("a.txt", "a"), s.write("b.txt", "b"));
    assert_eq!(s.fs.rename(&a, &b).await, Err(Error::Conflict(format!("already exists: {}", b.display()))));
    let renamed = s.root.join("renamed.txt");
    s.fs.rename(&a, &renamed).await.expect("rename");
    assert!(!a.exists() && renamed.exists());
    let nope = s.root.join("nope.txt");
    assert_eq!(
        s.fs.rename(&nope, &s.root.join("x.txt")).await,
        Err(Error::not_found("path", nope.display().to_string()))
    );

    fs::create_dir(s.root.join("folder")).expect("mkdir");
    let moved = s.root.join("folder/renamed.txt");
    s.fs.move_entry(&renamed, &moved, false).await.expect("move");
    assert_eq!(fs::read_to_string(&moved).expect("read"), "a");
    assert_eq!(
        s.fs.move_entry(&b, &moved, false).await,
        Err(Error::Conflict(format!("already exists: {}", moved.display())))
    );
    s.fs.move_entry(&b, &moved, true).await.expect("overwrite");
    assert_eq!(fs::read_to_string(&moved).expect("read"), "b");
}

#[tokio::test]
async fn trashing_moves_the_path_into_the_fallback_folder() {
    let s = sandbox();
    let folder = s.root.join("project");
    s.write("project/src/a.txt", "kept");
    s.fs.trash(&folder).await.expect("trash");
    assert!(!folder.exists());
    let trashed: Vec<_> =
        fs::read_dir(s.root.join(".eos-trash")).expect("trash folder").filter_map(Result::ok).collect();
    assert_eq!(trashed.len(), 1);
    assert_eq!(fs::read_to_string(trashed[0].path().join("src/a.txt")).expect("read"), "kept");
    assert!(s.fs.trash(&s.root.join("gone")).await.is_err());
}
