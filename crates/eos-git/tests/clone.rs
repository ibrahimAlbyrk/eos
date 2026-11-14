//! A plugin's repository cloned for an install, against repositories made on
//! this computer: nothing leaves it.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use eos_core::plugin::PluginCloner;
use eos_git::PluginClones;

const MANIFEST: &str = r#"{"id":"clock","name":"Clock","version":"1.2.0"}"#;

/// `git` for the test's own set-up, untouched by the user's settings.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

struct Repo {
    _root: tempfile::TempDir,
    dir: PathBuf,
    url: String,
    head: String,
}

/// A repository holding a plugin, a link, and a second branch.
fn repo() -> Repo {
    let root = tempfile::tempdir().expect("a folder");
    let dir = root.path().join("clock.git-src");
    fs::create_dir(&dir).expect("a folder");
    git(&dir, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(dir.join("plugin.json"), MANIFEST).expect("a file");
    fs::write(dir.join("ui.jsx"), "export default () => {};").expect("a file");
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", dir.join("hosts")).expect("a link");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "--quiet", "-m", "first"]);
    git(&dir, &["checkout", "--quiet", "-b", "next"]);
    fs::write(dir.join("ui.jsx"), "export default () => 2;").expect("a file");
    git(&dir, &["commit", "--quiet", "-am", "second"]);
    git(&dir, &["checkout", "--quiet", "main"]);
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let url = format!("file://{}", dir.display());
    Repo { _root: root, dir, url, head }
}

fn local() -> PluginClones {
    PluginClones::new(support::adapter()).allow_protocols("file")
}

#[tokio::test(flavor = "multi_thread")]
async fn clones_one_commit_pins_it_and_drops_the_repository_folder() {
    let repo = repo();
    let dir = tempfile::tempdir().expect("a folder");
    let commit = local().shallow_clone(&repo.url, None, dir.path()).await.expect("clones");
    assert_eq!(commit, repo.head);
    assert_eq!(fs::read_to_string(dir.path().join("plugin.json")).expect("the manifest"), MANIFEST);
    assert!(!dir.path().join(".git").exists());

    let next = tempfile::tempdir().expect("a folder");
    let commit = local().shallow_clone(&repo.url, Some("next"), next.path()).await.expect("clones");
    assert_eq!(commit, git(&repo.dir, &["rev-parse", "next"]));
    assert_eq!(fs::read_to_string(next.path().join("ui.jsx")).expect("the entry"), "export default () => 2;");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_link_in_the_repository_arrives_as_a_plain_file() {
    let repo = repo();
    let dir = tempfile::tempdir().expect("a folder");
    local().shallow_clone(&repo.url, None, dir.path()).await.expect("clones");
    let meta = fs::symlink_metadata(dir.path().join("hosts")).expect("the entry");
    assert!(meta.is_file() && !meta.file_type().is_symlink(), "not a link");
    assert_eq!(fs::read_to_string(dir.path().join("hosts")).expect("its text"), "/etc/hosts");
}

/// A `git` whose user settings name a hooks folder and a template with a
/// `post-checkout` hook — both would run during a plain clone.
#[cfg(unix)]
fn git_with_hooks(root: &Path, marker: &Path) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let hook = format!("#!/bin/sh\necho ran >> '{}'\n", marker.display());
    for folder in ["hooks", "template/hooks"] {
        fs::create_dir_all(root.join(folder)).expect("folders");
        let path = root.join(folder).join("post-checkout");
        fs::write(&path, &hook).expect("a hook");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("executable");
    }
    let config = root.join("gitconfig");
    fs::write(
        &config,
        format!(
            "[core]\n\thooksPath = {}\n[init]\n\ttemplateDir = {}\n",
            root.join("hooks").display(),
            root.join("template").display()
        ),
    )
    .expect("a config");
    let wrapper = root.join("git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL='{}'\nexport GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
            config.display()
        ),
    )
    .expect("a wrapper");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).expect("executable");
    (wrapper, config)
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn no_hook_runs_whatever_the_users_git_settings_say() {
    let repo = repo();
    let root = tempfile::tempdir().expect("a folder");
    let marker = root.path().join("hook-ran");
    let (wrapper, config) = git_with_hooks(root.path(), &marker);

    // The control: with those settings a plain clone does run the hook.
    let plain = root.path().join("plain");
    let out = Command::new("git")
        .args(["clone", "--quiet", &repo.url])
        .arg(&plain)
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ALLOW_PROTOCOL", "file")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(marker.exists(), "the settings do run a hook on a plain clone");
    fs::remove_file(&marker).expect("removed");

    let dir = root.path().join("stage");
    fs::create_dir(&dir).expect("a folder");
    local().program(wrapper).shallow_clone(&repo.url, None, &dir).await.expect("clones");
    assert!(dir.join("plugin.json").exists());
    assert!(!marker.exists(), "no hook ran");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_https_is_cloned_and_failures_say_what_git_said() {
    let repo = repo();
    let dir = tempfile::tempdir().expect("a folder");
    let refused =
        PluginClones::new(support::adapter()).shallow_clone(&repo.url, None, dir.path()).await.expect_err("refused");
    let text = refused.to_string();
    assert!(text.starts_with(&format!("couldn't clone {}: ", repo.url)) && text.contains("not allowed"), "{text}");

    let missing = format!("file://{}/nope", repo.dir.display());
    let error = local().shallow_clone(&missing, Some("v9"), dir.path()).await.expect_err("fails").to_string();
    assert!(error.starts_with(&format!("couldn't clone {missing} at v9: ")), "{error}");
    let error = local().shallow_clone(&repo.url, Some("no-such-branch"), dir.path()).await.expect_err("fails");
    assert!(error.to_string().contains("no-such-branch"), "{error}");
}
