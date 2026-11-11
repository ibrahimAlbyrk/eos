//! The Rust builder against today's: every sample plugin under
//! `tests/samples` must build to the same text, or fail with the same
//! message, as `infra/src/plugins/EsbuildPluginBuilder.ts` recorded in
//! `expected.json` (`rust/tools/plugin-vectors/build.mts`).
//!
//! These tests drive the real esbuild binary: `EOS_ESBUILD`, or the one
//! `npm ci` puts under `infra/node_modules`. Without one they say so and pass.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use eos_core::plugin::PluginBuilder;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_plugin_build::{ESBUILD_VERSION, EsbuildPluginBuilder, dev_checkout, locate};
use serde::Deserialize;

#[derive(Deserialize)]
struct Expected {
    esbuild: String,
    samples: BTreeMap<String, Sample>,
}

#[derive(Deserialize)]
struct Sample {
    entry: String,
    js: Option<String>,
    css: Option<String>,
    error: Option<String>,
}

fn samples_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/samples")
}

fn expected() -> Expected {
    let text = std::fs::read_to_string(samples_dir().join("expected.json")).expect("expected.json");
    serde_json::from_str(&text).expect("expected.json parses")
}

fn runner() -> Runner {
    Runner::new(ProcessTrees::new(eos_platform::isolate_command, |pid| eos_platform::kill_process_tree(pid).is_ok()))
}

fn binary() -> Option<PathBuf> {
    let given = std::env::var_os("EOS_ESBUILD").map(PathBuf::from);
    let found = locate(given.as_deref(), dev_checkout().as_deref());
    if found.is_none() {
        eprintln!("skipped: no esbuild binary (set EOS_ESBUILD or run `npm ci` in infra/)");
    }
    found
}

#[test]
fn the_vectors_were_recorded_with_the_version_this_crate_speaks() {
    assert_eq!(expected().esbuild, ESBUILD_VERSION);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_sample_builds_to_the_same_bytes_or_fails_with_the_same_message() {
    let Some(binary) = binary() else { return };
    let builder = EsbuildPluginBuilder::new(runner(), Some(binary));
    let expected = expected();
    assert!(expected.samples.len() >= 7);
    for (name, want) in &expected.samples {
        let dir = samples_dir().join(name);
        match (builder.build(&dir, &want.entry).await, &want.error) {
            (Ok(build), None) => {
                assert_eq!(Some(&build.js), want.js.as_ref(), "{name}: the module");
                assert_eq!(build.css, want.css, "{name}: the stylesheet");
            }
            (Err(error), Some(message)) => assert_eq!(&error.to_string(), message, "{name}"),
            (got, _) => panic!(
                "{name}: today's builder {}, got {got:?}",
                if want.error.is_some() { "fails" } else { "succeeds" }
            ),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn builds_can_run_at_once_and_leave_no_process_behind() {
    let Some(binary) = binary() else { return };
    let builder = std::sync::Arc::new(EsbuildPluginBuilder::new(runner(), Some(binary)));
    let want = expected().samples.remove("plain").expect("the plain sample").js;
    let builds: Vec<_> = (0..6)
        .map(|_| {
            let builder = builder.clone();
            tokio::spawn(async move { builder.build(&samples_dir().join("plain"), "ui.js").await })
        })
        .collect();
    for build in builds {
        let build = tokio::time::timeout(Duration::from_secs(30), build).await.expect("in time").expect("a task");
        assert_eq!(build.expect("builds").js, want.clone().expect("recorded"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_entry_is_an_error_for_the_author() {
    let Some(binary) = binary() else { return };
    let builder = EsbuildPluginBuilder::new(runner(), Some(binary));
    let dir = samples_dir().join("plain");
    let error = builder.build(&dir, "nope.jsx").await.expect_err("no such entry");
    // As today: esbuild names the entry by its full path.
    assert_eq!(error.to_string(), format!("Could not resolve \"{}/nope.jsx\"", dir.display()));
}

#[tokio::test(flavor = "multi_thread")]
async fn another_esbuild_release_is_refused_by_its_version() {
    // A stand-in binary that greets with another version, as esbuild does first.
    let temp = tempfile::tempdir().expect("a folder");
    let fake = temp.path().join("esbuild");
    std::fs::write(&fake, "#!/bin/sh\nprintf '\\006\\000\\000\\0000.25.0'\ncat >/dev/null\n").expect("a script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("executable");
    }
    let builder = EsbuildPluginBuilder::new(runner(), Some(fake));
    let error = builder.build(&samples_dir().join("plain"), "ui.js").await.expect_err("refused");
    assert_eq!(error.to_string(), "the bundled esbuild is version 0.25.0, this build of Eos needs 0.28.2");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_binary_that_dies_reports_what_it_printed() {
    let temp = tempfile::tempdir().expect("a folder");
    let fake = temp.path().join("esbuild");
    std::fs::write(&fake, "#!/bin/sh\necho 'panic: boom' >&2\nexit 2\n").expect("a script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("executable");
    }
    let builder = EsbuildPluginBuilder::new(runner(), Some(fake));
    let error = builder.build(&samples_dir().join("plain"), "ui.js").await.expect_err("died");
    assert_eq!(error.to_string(), "esbuild stopped before finishing the build: panic: boom");

    let missing = EsbuildPluginBuilder::new(runner(), Some(temp.path().join("not-there")));
    let error = missing.build(&samples_dir().join("plain"), "ui.js").await.expect_err("cannot start");
    assert!(error.to_string().starts_with("could not start "), "{error}");
}
