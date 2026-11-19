use std::fs::{self, File};

use eos_testkit::{FakeTrash, TempHome};

use super::*;

struct Rig {
    home: TempHome,
    trash: Arc<FakeTrash>,
    store: FsCapabilityFiles,
}

fn rig() -> Rig {
    let home = TempHome::new();
    let trash = Arc::new(FakeTrash::new(home.path().join("trash")));
    let store = FsCapabilityFiles::new(home.path().join("capabilities"), trash.clone());
    Rig { home, trash, store }
}

impl Rig {
    fn root(&self) -> PathBuf {
        self.home.path().join("capabilities")
    }

    /// A package of the SMS shape in `<home>/forge/<name>`.
    fn package(&self, name: &str) -> PathBuf {
        let dir = self.home.path().join("forge").join(name);
        for (relative, text) in [
            ("capability.toml", "id = \"sms-messages\"\n"),
            ("send.applescript", "on run argv\nend run\n"),
            ("tests/run.sh", "#!/bin/zsh\nexit 0\n"),
        ] {
            let path = dir.join(relative);
            fs::create_dir_all(path.parent().expect("a folder")).expect("folders");
            fs::write(path, text).expect("a file");
        }
        dir
    }

    /// What the version folders of `id` hold, by name.
    fn versions(&self, id: &str) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.root().join(id))
            .map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}

fn hash_of(dir: &Path) -> String {
    hash_dir(dir).expect("hashes")
}

#[tokio::test]
async fn an_install_leaves_only_the_final_folder_with_the_reviewed_files() {
    let rig = rig();
    let package = rig.package("one");
    let reviewed = hash_of(&package);
    rig.store.install(&package, "sms-messages", "1.0.0", &reviewed).await.expect("installs");
    assert_eq!(rig.versions("sms-messages"), ["1.0.0"], "no .partial left");
    let installed = rig.root().join("sms-messages/1.0.0");
    assert_eq!(fs::read_to_string(installed.join("tests/run.sh")).expect("copied"), "#!/bin/zsh\nexit 0\n");
    assert_eq!(rig.store.hash("sms-messages", "1.0.0").await.expect("hashes"), reviewed);
    assert!(package.join("capability.toml").exists(), "the package it came from stays");
    assert!(rig.trash.trashed().is_empty());

    let again = rig.store.install(&package, "sms-messages", "1.0.0", &reviewed).await;
    assert!(matches!(again, Err(Error::Conflict(_))), "{again:?}");
    rig.store.install(&package, "sms-messages", "1.0.1", &reviewed).await.expect("the next version");
    assert_eq!(rig.versions("sms-messages"), ["1.0.0", "1.0.1"]);
}

#[tokio::test]
async fn a_package_whose_hash_is_not_the_reviewed_one_leaves_no_folder_and_its_copy_goes_to_the_trash() {
    let rig = rig();
    let package = rig.package("changed");
    let reviewed = hash_of(&package);
    fs::write(package.join("send.applescript"), "do shell script \"curl evil.test\"\n").expect("an edit");
    let refused = rig.store.install(&package, "sms-messages", "1.0.0", &reviewed).await;
    assert!(matches!(refused, Err(Error::Rule(_))), "{refused:?}");
    assert!(rig.versions("sms-messages").is_empty(), "neither the version nor its .partial");
    assert_eq!(rig.trash.trashed(), [rig.root().join("sms-messages/1.0.0.partial")]);
    assert_eq!(
        fs::read_to_string(rig.trash.kept(0).join("send.applescript")).expect("kept in the trash"),
        "do shell script \"curl evil.test\"\n"
    );
}

#[tokio::test]
async fn a_package_too_large_or_holding_a_link_is_refused() {
    let rig = rig();
    let big = rig.package("big");
    let file = File::create(big.join("model.bin")).expect("a file");
    file.set_len(PACKAGE_MAX_BYTES).expect("a sparse file");
    let refused = rig.store.install(&big, "sms-messages", "1.0.0", "any").await;
    assert!(matches!(refused, Err(Error::LimitExceeded(_))), "{refused:?}");

    let linked = rig.package("linked");
    std::os::unix::fs::symlink(rig.home.path(), linked.join("home")).expect("a link");
    let refused = rig.store.install(&linked, "sms-messages", "1.0.0", "any").await;
    assert!(matches!(refused, Err(Error::Validation(_))), "{refused:?}");
    assert!(rig.versions("sms-messages").is_empty());
    assert!(rig.trash.trashed().is_empty(), "nothing was copied");

    for (id, version) in [("../x", "1"), ("sms", "../1"), ("sms", "data"), ("sms", "1.partial"), (".hidden", "1")] {
        let refused = rig.store.install(&linked, id, version, "any").await;
        assert!(matches!(refused, Err(Error::Validation(_))), "{id} {version}: {refused:?}");
    }
}

#[tokio::test]
async fn the_stamp_changes_when_a_file_does() {
    let rig = rig();
    let package = rig.package("stamped");
    rig.store.install(&package, "sms-messages", "1.0.0", &hash_of(&package)).await.expect("installs");
    let first = rig.store.stamp("sms-messages", "1.0.0").await.expect("stamps");
    assert_eq!(rig.store.stamp("sms-messages", "1.0.0").await.expect("stamps"), first, "nothing changed");
    let installed = rig.root().join("sms-messages/1.0.0");
    fs::write(installed.join("send.applescript"), "on run argv\n  -- edited\nend run\n").expect("an edit");
    assert_ne!(rig.store.stamp("sms-messages", "1.0.0").await.expect("stamps"), first);
    let after_edit = rig.store.stamp("sms-messages", "1.0.0").await.expect("stamps");
    fs::write(installed.join("extra.sh"), "").expect("a new file");
    assert_ne!(rig.store.stamp("sms-messages", "1.0.0").await.expect("stamps"), after_edit, "a new file too");
    let missing = rig.store.stamp("sms-messages", "9.9.9").await;
    assert!(matches!(missing, Err(Error::NotFound { .. })), "{missing:?}");
}

#[tokio::test]
async fn removing_a_version_and_the_start_sweep_go_through_the_trash() {
    let rig = rig();
    let package = rig.package("kept");
    let hash = hash_of(&package);
    rig.store.install(&package, "sms-messages", "1.0.0", &hash).await.expect("installs");
    rig.store.install(&package, "sms-messages", "1.0.1", &hash).await.expect("installs");
    fs::create_dir_all(rig.root().join("sms-messages/data")).expect("the code's own state");
    fs::create_dir_all(rig.root().join("sms-messages/1.0.2.partial/tests")).expect("a stopped install");
    fs::create_dir_all(rig.root().join("notes-db/2.0.0.partial")).expect("another stopped install");

    assert_eq!(rig.store.sweep().await.expect("sweeps"), 2);
    rig.store.remove("sms-messages", "1.0.0").await.expect("removes");
    assert_eq!(
        rig.trash.trashed(),
        [
            rig.root().join("notes-db/2.0.0.partial"),
            rig.root().join("sms-messages/1.0.2.partial"),
            rig.root().join("sms-messages/1.0.0"),
        ]
    );
    assert_eq!(rig.versions("sms-messages"), ["1.0.1", "data"], "the active version and the code's state stay");
    assert_eq!(hash_of(&rig.trash.kept(2)), hash, "the removed version is whole in the trash");
    assert_eq!(rig.store.sweep().await.expect("sweeps"), 0);
    let missing = rig.store.remove("sms-messages", "1.0.0").await;
    assert!(matches!(missing, Err(Error::NotFound { .. })), "{missing:?}");
}

#[tokio::test]
async fn a_leftover_partial_of_the_same_version_goes_to_the_trash_before_the_copy() {
    let rig = rig();
    let package = rig.package("again");
    fs::create_dir_all(rig.root().join("sms-messages/1.0.0.partial")).expect("a stopped install");
    fs::write(rig.root().join("sms-messages/1.0.0.partial/half"), "half").expect("a half copy");
    rig.store.install(&package, "sms-messages", "1.0.0", &hash_of(&package)).await.expect("installs");
    assert_eq!(rig.versions("sms-messages"), ["1.0.0"]);
    assert!(!rig.root().join("sms-messages/1.0.0/half").exists(), "the half copy is not part of it");
    assert_eq!(rig.trash.trashed(), [rig.root().join("sms-messages/1.0.0.partial")]);
}

#[tokio::test]
async fn a_file_is_read_only_from_inside_the_installed_package() {
    let rig = rig();
    let package = rig.package("read");
    rig.store.install(&package, "sms-messages", "1.0.0", &hash_of(&package)).await.expect("installs");
    let text = rig.store.read_text("sms-messages", "1.0.0", "tests/run.sh").await.expect("reads");
    assert_eq!(text, "#!/bin/zsh\nexit 0\n");
    for outside in ["../1.0.0/capability.toml", "/etc/hosts", "tests/../../x", ".hidden", ""] {
        let refused = rig.store.read_text("sms-messages", "1.0.0", outside).await;
        assert!(matches!(refused, Err(Error::Validation(_))), "{outside}: {refused:?}");
    }
    let missing = rig.store.read_text("sms-messages", "9.9.9", "capability.toml").await;
    assert!(matches!(missing, Err(Error::NotFound { .. })), "{missing:?}");
}
