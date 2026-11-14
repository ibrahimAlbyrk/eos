//! Project keys over real repositories with invented remotes (never contacted).

mod support;

use std::sync::{Arc, Mutex};

use eos_core::SystemClock;
use eos_core::git::ProjectKeys;
use eos_git::{GitProjectKeys, KnownFolders};
use support::{Dir, adapter, git_ok, init_repo};

fn keys(learned: &Dir, folders: &Arc<Mutex<Vec<String>>>) -> GitProjectKeys {
    let known = folders.clone();
    let candidates: KnownFolders = Arc::new(move || known.lock().expect("lock").clone());
    GitProjectKeys::new(Arc::new(adapter()), candidates, learned.join("sync/project-keys.json"), Arc::new(SystemClock))
}

fn cloned(remote: &str) -> Dir {
    let repo = init_repo("eos-keys-");
    git_ok(&repo.path, &["remote", "add", "origin", remote]);
    repo
}

fn text(dir: &Dir) -> String {
    dir.path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn a_folder_travels_as_its_remote_and_comes_back_as_this_computers_checkout() {
    let (data, folders) = (Dir::new("eos-keys-data-"), Arc::new(Mutex::new(Vec::new())));
    let keys = keys(&data, &folders);
    let repo = cloned("git@GitHub.com:Owner/repo.git");
    repo.write("packages/ui/a.txt", "x");
    let plain = Dir::new("eos-keys-plain-");

    assert_eq!(keys.to_key(&text(&repo)).await, "git:github.com/Owner/repo");
    let sub = repo.join("packages/ui").to_string_lossy().into_owned();
    assert_eq!(keys.to_key(&sub).await, "git:github.com/Owner/repo#packages/ui");
    assert_eq!(keys.to_key(&text(&plain)).await, format!("path:{}", text(&plain)));
    assert_eq!(keys.to_key("/no/such/folder").await, "path:/no/such/folder");

    // Nothing known yet: the key is not found, and the sender's path is kept.
    assert_eq!(keys.find_path("git:github.com/Owner/repo").await, None);
    assert_eq!(keys.find_path("path:/a").await, None, "only git keys are looked for");
    assert_eq!(keys.to_path("path:/a/b", "/hint").await, "/a/b");

    folders.lock().expect("lock").extend([text(&plain), text(&repo)]);
    assert_eq!(keys.find_path("git:github.com/Owner/repo").await, Some(text(&repo)));
    assert_eq!(keys.to_path("git:github.com/Owner/repo#packages/ui", "/elsewhere/ui").await, sub);
    assert_eq!(keys.find_path("git:github.com/other/repo").await, None);
}

#[tokio::test]
async fn a_key_that_cannot_be_placed_keeps_the_hint_and_is_remembered_for_it() {
    let (data, folders) = (Dir::new("eos-keys-data-"), Arc::new(Mutex::new(Vec::new())));
    let hint = Dir::new("eos-keys-hint-");
    let key = "git:github.com/not/cloned";
    {
        let keys = keys(&data, &folders);
        assert_eq!(keys.to_path(key, &text(&hint)).await, text(&hint));
        // The folder has no repository, yet it goes back out under the key it came in with.
        assert_eq!(keys.to_key(&text(&hint)).await, key);
    }
    let saved = data.read("sync/project-keys.json");
    assert_eq!(saved, format!("{{\n  \"{}\": \"{key}\"\n}}", text(&hint)));
    assert_eq!(keys(&data, &folders).to_key(&text(&hint)).await, key, "remembered across restarts");

    // The hint itself is looked at first: a checkout there answers without any known folder.
    let repo = cloned("https://github.com/Owner/repo.git");
    let fresh = keys(&data, &folders);
    assert_eq!(fresh.to_path("git:github.com/Owner/repo", &text(&repo)).await, text(&repo));
}
