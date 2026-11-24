//! The SMS reference package in `fixtures/capabilities/sms-messages/`: its
//! manifest passes the check, it reaches only Messages and only the user,
//! and its own offline tests pass with a fake `osascript`, so nothing here
//! reaches Messages.

use std::path::{Path, PathBuf};

use eos_domain::capability::check::check;
use eos_domain::capability::manifest::{Form, Recipient, parse};

fn package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/capabilities/sms-messages")
}

#[test]
fn its_manifest_passes_the_check_and_reaches_only_messages_and_the_user() {
    let text = std::fs::read_to_string(package_dir().join("capability.toml")).expect("read");
    let manifest = parse(&text).expect("a manifest");
    assert_eq!(check(&manifest), Vec::new());
    assert_eq!(manifest.form, Form::Script);
    assert!(manifest.reach.hosts.is_empty() && manifest.reach.files_read.is_empty());
    assert_eq!(manifest.reach.apple_events, ["com.apple.MobileSMS"]);
    let send = manifest.actions.iter().find(|a| a.name == "send_to_me").expect("its send");
    assert_eq!(send.recipient, Recipient::User, "the number is the user's setting, never the input's");
    assert_eq!(manifest.tests.as_ref().and_then(|t| t.live.as_deref()), Some("send_to_me"));
    for file in ["README.md", "send.sh", "send.js", "check.js", "tests/run.sh", "tests/fake-osascript"] {
        assert!(package_dir().join(file).is_file(), "{file}");
    }
}

#[test]
fn its_offline_tests_pass_with_a_fake_osascript() {
    let temp = tempfile::tempdir().expect("a folder");
    let output = std::process::Command::new("/bin/zsh")
        .arg("tests/run.sh")
        .current_dir(package_dir())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", temp.path())
        .env("TMPDIR", temp.path())
        .output()
        .expect("ran");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
