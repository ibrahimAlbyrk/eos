//! The script form: the echo package from `fixtures/capabilities/` answers
//! its input under the confinement the test scripts; failures, deadlines,
//! long answers, paths the sandbox cannot name and a Mac without the
//! sandbox.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_capability_host::{SANDBOX_UNAVAILABLE, ScriptHost};
use eos_core::BoxFuture;
use eos_core::capability::{
    ActionError, ActionRunner, ConfineError, ConfineSpec, Confined, Confinement, FailureKind, Package,
};
use eos_domain::capability::manifest::parse;
use eos_testkit::{FakeConfinement, SeqIds};
use serde_json::{Value, json};
use zeroize::Zeroizing;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/capabilities/echo-script")
}

struct Rig {
    _home: tempfile::TempDir,
    root: PathBuf,
    temp: PathBuf,
    confinement: Arc<FakeConfinement>,
    host: ScriptHost,
    package: Package,
}

/// The echo package installed as `<root>/echo-script/1.0.0/`.
fn rig(edit: impl FnOnce(&mut Package)) -> Rig {
    let home = tempfile::tempdir().expect("a folder");
    let (root, temp) = (home.path().join("capabilities"), home.path().join("scratch"));
    let installed = root.join("echo-script").join("1.0.0");
    std::fs::create_dir_all(&installed).expect("made");
    for file in ["capability.toml", "echo.sh"] {
        std::fs::copy(fixture_dir().join(file), installed.join(file)).expect("copied");
    }
    let text = std::fs::read_to_string(installed.join("capability.toml")).expect("read");
    let mut package =
        Package { id: "echo-script".into(), version: "1.0.0".into(), manifest: parse(&text).expect("a manifest") };
    edit(&mut package);
    let confinement = Arc::new(FakeConfinement::new());
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    let host =
        ScriptHost::new(&root, &temp, confinement.clone(), eos_kit_proc::Runner::new(trees), Arc::new(SeqIds::new()));
    Rig { _home: home, root, temp, confinement, host, package }
}

impl Rig {
    async fn echo(&self, input: Value, timeout: Duration) -> Result<Value, ActionError> {
        let env = vec![("ECHO_TOKEN".to_owned(), Zeroizing::new("s3cret".to_owned()))];
        self.host.run(&self.package, "echo", input, env, timeout).await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_script_answers_its_input_in_its_package_folder_with_only_its_own_variables() {
    let rig = rig(|_| {});
    let answer = rig.echo(json!({"text": "hi"}), Duration::from_secs(5)).await.expect("answers");
    assert_eq!(answer["input"], json!({"text": "hi"}));
    assert_eq!(answer["token"], "yes", "the secret reaches its variable");
    let vars: Vec<&str> = answer["vars"].as_str().expect("names").split_whitespace().collect();
    assert!(
        vars.iter().all(|var| ["ECHO_TOKEN", "HOME", "PATH", "PWD", "SHLVL", "_", "OLDPWD"].contains(var)),
        "{vars:?}"
    );

    let specs = rig.confinement.specs();
    assert_eq!(specs.len(), 1, "every call is confined");
    let spec = &specs[0];
    let package = rig.root.join("echo-script/1.0.0");
    assert_eq!((spec.program.as_path(), spec.args.as_slice()), (Path::new("/bin/sh"), &["echo.sh".to_owned()][..]));
    assert_eq!((&spec.cwd, &spec.package, &spec.data), (&package, &package, &rig.root.join("echo-script/data")));
    assert!(spec.tmpdir.starts_with(&rig.temp) && !spec.audit);
    assert!(!spec.tmpdir.exists(), "the call's temp folder goes with it");
    assert!(spec.data.is_dir(), "its data folder is made");
    assert!(!format!("{spec:?}").contains("s3cret"), "a spec never shows a secret");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_garbled_slow_or_flooding_script_fails_its_call() {
    let rig = rig(|_| {});
    let code = ActionError::Failed { kind: FailureKind::Code };
    assert_eq!(rig.echo(json!({"mode": "fail"}), Duration::from_secs(5)).await, Err(code.clone()));
    let output = ActionError::Failed { kind: FailureKind::Output };
    assert_eq!(rig.echo(json!({"mode": "garble"}), Duration::from_secs(5)).await, Err(output));
    assert_eq!(rig.echo(json!({"mode": "sleep"}), Duration::from_millis(300)).await, Err(ActionError::Timeout));
    assert_eq!(rig.echo(json!({"mode": "flood"}), Duration::from_secs(5)).await, Err(code));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_the_sandbox_cannot_name_runs_nothing() {
    for edit in [
        (|p: &mut Package| p.manifest.actions[0].run[0] = "sh".into()) as fn(&mut Package),
        |p: &mut Package| p.manifest.reach.files_read = vec!["~/notes.txt".into()],
        |p: &mut Package| p.manifest.actions[0].run.clear(),
    ] {
        let rig = rig(edit);
        let refused = rig.echo(json!({}), Duration::from_secs(5)).await;
        assert_eq!(refused, Err(ActionError::Failed { kind: FailureKind::Code }));
        assert!(rig.confinement.specs().is_empty(), "nothing was confined, nothing ran");
    }
    let rig = rig(|_| {});
    let missing = rig.host.run(&rig.package, "nope", json!({}), Vec::new(), Duration::from_secs(1)).await;
    assert_eq!(missing, Err(ActionError::NotFound));
}

/// A Mac whose sandbox does not work.
struct NoSandbox;

impl Confinement for NoSandbox {
    fn command(&self, _spec: ConfineSpec) -> BoxFuture<'_, Result<Confined, ConfineError>> {
        Box::pin(std::future::ready(Err(ConfineError::Unavailable)))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_sandbox_no_action_runs() {
    let rig = rig(|_| {});
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    let host = ScriptHost::new(
        &rig.root,
        &rig.temp,
        Arc::new(NoSandbox),
        eos_kit_proc::Runner::new(trees),
        Arc::new(SeqIds::new()),
    );
    let marker = rig.root.join("echo-script/data/ran");
    let refused = host.run(&rig.package, "echo", json!({}), Vec::new(), Duration::from_secs(5)).await;
    assert_eq!(refused, Err(ActionError::NotReady(SANDBOX_UNAVAILABLE.into())));
    assert!(!marker.exists());
}
