//! The YAML writer against the `yaml` package itself: every value in
//! `tests/fixtures/yaml-vectors.json` (written by `scripts/gen-yaml-vectors.mjs`)
//! must come out byte for byte as the package wrote it.

use eos_kit_fs::{frontmatter, to_yaml};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Vector {
    value: Value,
    yaml: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    meta: Value,
    body: String,
    file: String,
    read_back: Value,
    body_back: String,
}

#[derive(Deserialize)]
struct Fixture {
    vectors: Vec<Vector>,
    files: Vec<File>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/yaml-vectors.json")).expect("fixture")
}

#[test]
fn values_are_written_as_the_yaml_package_writes_them() {
    let fixture = fixture();
    assert!(fixture.vectors.len() > 2000);
    let mut failures = Vec::new();
    for (i, v) in fixture.vectors.iter().enumerate() {
        let ours = to_yaml(&v.value).expect("writable");
        if ours != v.yaml {
            failures.push(format!("#{i} value {}\n  theirs {:?}\n  ours   {:?}", v.value, v.yaml, ours));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        fixture.vectors.len(),
        failures[..failures.len().min(12)].join("\n")
    );
}

#[test]
fn files_are_joined_and_read_back_as_typescript_does() {
    for f in fixture().files {
        assert_eq!(frontmatter::join(&f.meta, &f.body).expect("join"), f.file);
        let (meta, body) = frontmatter::parse::<Value>(&f.file).expect("parse").expect("frontmatter");
        assert_eq!(meta, f.read_back);
        assert_eq!(body, f.body_back);
    }
}

/// Private data: every frontmatter file under `$EOS_TEST_HOME` (pages,
/// memories, templates, workers) must survive read → write unchanged. Prints
/// counts only.
#[test]
fn real_files_keep_their_bytes() {
    let Some(home) = std::env::var_os("EOS_TEST_HOME").map(std::path::PathBuf::from) else {
        eprintln!("EOS_TEST_HOME not set: skipped");
        return;
    };
    let (mut same, mut different, mut skipped) = (0, 0, 0);
    for dir in ["pages", "profile/memories", "templates", "workers"] {
        let Ok(entries) = std::fs::read_dir(home.join(dir)) else { continue };
        for path in entries.filter_map(|e| Some(e.ok()?.path())).filter(|p| p.extension().is_some_and(|e| e == "md")) {
            let raw = std::fs::read_to_string(&path).expect("read");
            // Through the YAML library's own value, which keeps key order.
            match frontmatter::parse::<serde_norway::Value>(&raw) {
                Ok(Some((meta, body))) => {
                    if frontmatter::join(&meta, body).expect("join") == raw {
                        same += 1
                    } else {
                        different += 1
                    }
                }
                _ => skipped += 1,
            }
        }
    }
    eprintln!("{same} files unchanged, {different} differ, {skipped} without frontmatter");
    assert!(same > 0);
    assert_eq!(different, 0);
}
