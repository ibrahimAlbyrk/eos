//! The MCP form: the echo server from `fixtures/capabilities/` answers its
//! tools as a confined child that lives across calls; tools that are not
//! the reviewed ones, three crashes in ten minutes, idle servers, the limit
//! on servers alive and a Mac without the sandbox.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use eos_capability_host::{
    CRASH_WINDOW_MS, CapabilityHost, HostParts, IDLE_STOP_MS, SANDBOX_UNAVAILABLE, SERVER_CRASHED, SERVERS_ALIVE_MAX,
    TOOLS_CHANGED,
};
use eos_core::BoxFuture;
use eos_core::capability::{
    ActionError, ActionRunner, ConfineError, ConfineSpec, Confined, Confinement, FailureKind, Package,
};
use eos_domain::capability::manifest::parse;
use eos_testkit::{FakeClock, FakeConfinement, FakeSleeper, SeqIds};
use serde_json::{Value, json};
use zeroize::Zeroizing;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/capabilities/echo-mcp")
}

struct Rig {
    _home: tempfile::TempDir,
    root: PathBuf,
    temp: PathBuf,
    confinement: Arc<FakeConfinement>,
    clock: Arc<FakeClock>,
    sleeper: Arc<FakeSleeper>,
    host: CapabilityHost,
    package: Package,
}

/// The echo server installed as `<root>/<id>/1.0.0/`.
fn install(root: &Path, id: &str) -> Package {
    let installed = root.join(id).join("1.0.0");
    std::fs::create_dir_all(&installed).expect("made");
    for file in ["capability.toml", "server.pl"] {
        std::fs::copy(fixture_dir().join(file), installed.join(file)).expect("copied");
    }
    let text = std::fs::read_to_string(installed.join("capability.toml")).expect("read");
    Package { id: id.into(), version: "1.0.0".into(), manifest: parse(&text).expect("a manifest") }
}

fn host(
    root: &Path,
    temp: &Path,
    confinement: Arc<dyn Confinement>,
    clock: Arc<FakeClock>,
    sleeper: Arc<FakeSleeper>,
) -> CapabilityHost {
    let trees = eos_kit_proc::ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    });
    CapabilityHost::new(HostParts {
        root: root.to_owned(),
        temp: temp.to_owned(),
        confinement,
        runner: eos_kit_proc::Runner::new(trees),
        ids: Arc::new(SeqIds::new()),
        clock,
        sleeper,
    })
}

fn rig(edit: impl FnOnce(&mut Package)) -> Rig {
    let home = tempfile::tempdir().expect("a folder");
    let (root, temp) = (home.path().join("capabilities"), home.path().join("scratch"));
    let mut package = install(&root, "echo-mcp");
    edit(&mut package);
    let (confinement, clock, sleeper) =
        (Arc::new(FakeConfinement::new()), Arc::new(FakeClock::new()), Arc::new(FakeSleeper::default()));
    let host = host(&root, &temp, confinement.clone(), clock.clone(), sleeper.clone());
    Rig { _home: home, root, temp, confinement, clock, sleeper, host, package }
}

impl Rig {
    async fn call(&self, package: &Package, action: &str, input: Value) -> Result<Value, ActionError> {
        let env = vec![("ECHO_TOKEN".to_owned(), Zeroizing::new("s3cret".to_owned()))];
        self.host.run(package, action, input, env, Duration::from_secs(5)).await
    }

    async fn echo(&self) -> Result<Value, ActionError> {
        self.call(&self.package, "echo", json!({"text": "hi"})).await
    }

    /// The pid of the server that answered.
    async fn pid(&self, package: &Package) -> u64 {
        let answer = self.call(package, "echo", json!({})).await.expect("answers");
        answer["pid"].as_u64().expect("a pid")
    }
}

/// Lets the host's own tasks settle: a server's end, an idle watch.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn one_confined_server_answers_every_call_with_only_its_own_variables() {
    let rig = rig(|_| {});
    let answer = rig.echo().await.expect("answers");
    assert_eq!(answer["input"], json!({"text": "hi"}));
    assert_eq!(answer["token"], "yes", "the secret reaches its variable");
    let vars: Vec<&str> = answer["vars"].as_str().expect("names").split_whitespace().collect();
    assert!(vars.iter().all(|var| ["ECHO_TOKEN", "HOME", "PATH"].contains(var)), "{vars:?}");
    let pid = answer["pid"].as_u64();
    assert_eq!(rig.echo().await.expect("answers")["pid"].as_u64(), pid, "the same server answers again");

    let specs = rig.confinement.specs();
    assert_eq!(specs.len(), 1, "the server was confined once, when it started");
    let spec = &specs[0];
    let package = rig.root.join("echo-mcp/1.0.0");
    assert_eq!(
        (spec.program.as_path(), spec.args.as_slice()),
        (Path::new("/usr/bin/perl"), &["server.pl".to_owned()][..])
    );
    assert_eq!((&spec.cwd, &spec.package, &spec.data), (&package, &package, &rig.root.join("echo-mcp/data")));
    assert!(spec.tmpdir.starts_with(&rig.temp) && !spec.audit);
    assert!(!format!("{spec:?}").contains("s3cret"), "a spec never shows a secret");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_error_fails_the_call_and_a_missed_deadline_ends_the_server() {
    let rig = rig(|_| {});
    let pid = rig.pid(&rig.package).await;
    assert_eq!(rig.call(&rig.package, "fail", json!({})).await, Err(ActionError::Failed { kind: FailureKind::Code }));
    assert_eq!(rig.pid(&rig.package).await, pid, "an error leaves the server running");
    let hung = rig.host.run(&rig.package, "hang", json!({}), Vec::new(), Duration::from_millis(300)).await;
    assert_eq!(hung, Err(ActionError::Timeout));
    settle().await;
    assert!(!alive(pid), "the stuck server was ended");
    assert_ne!(rig.pid(&rig.package).await, pid);
    assert_eq!(rig.confinement.specs().len(), 2, "a stuck server is no crash: it starts again");
    let missing = rig.call(&rig.package, "nope", json!({})).await;
    assert_eq!(missing, Err(ActionError::NotFound));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_whose_tools_are_not_the_reviewed_ones_is_not_believed() {
    for edit in [
        (|p: &mut Package| p.manifest.actions[0].summary = "Something else.".into()) as fn(&mut Package),
        |p: &mut Package| {
            p.manifest.actions.pop();
        },
        |p: &mut Package| p.manifest.actions[0].tool = Some("echo_v2".into()),
    ] {
        let rig = rig(edit);
        let refused = rig.call(&rig.package, "fail", json!({})).await;
        assert_eq!(refused, Err(ActionError::NotReady(TOOLS_CHANGED.into())));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn three_crashes_in_ten_minutes_break_it_until_the_window_has_passed() {
    let rig = rig(|_| {});
    for _ in 0..2 {
        assert!(rig.call(&rig.package, "crash", json!({})).await.is_err());
        settle().await;
    }
    let third = rig.call(&rig.package, "crash", json!({})).await;
    settle().await;
    let after = rig.echo().await;
    assert!(
        [third, after.clone()].contains(&Err(ActionError::NotReady(SERVER_CRASHED.into()))),
        "the third crash breaks it"
    );
    assert_eq!(after, Err(ActionError::NotReady(SERVER_CRASHED.into())));
    assert_eq!(rig.confinement.specs().len(), 3, "it was not started again");

    rig.clock.advance(CRASH_WINDOW_MS + 1);
    assert!(rig.echo().await.is_ok(), "once the window passed, it starts again");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_server_is_stopped_and_a_stopped_one_starts_again() {
    let rig = rig(|_| {});
    let first = rig.pid(&rig.package).await;
    assert_eq!(rig.sleeper.pending(), vec![IDLE_STOP_MS], "an idle watch waits");
    rig.sleeper.wake();
    settle().await;
    assert_eq!(rig.pid(&rig.package).await, first, "used just now, it stays");

    rig.clock.advance(IDLE_STOP_MS);
    rig.sleeper.wake();
    settle().await;
    let second = rig.pid(&rig.package).await;
    assert_ne!(second, first, "the idle one was stopped");
    assert!(!alive(first));

    rig.host.stop("echo-mcp").await;
    settle().await;
    assert!(!alive(second), "stop ends it");
    assert_ne!(rig.pid(&rig.package).await, second);
    assert_eq!(rig.confinement.specs().len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn past_the_limit_the_least_used_server_makes_room() {
    let rig = rig(|_| {});
    let packages: Vec<Package> = (0..SERVERS_ALIVE_MAX).map(|n| install(&rig.root, &format!("echo-{n}"))).collect();
    let mut pids = Vec::new();
    for package in &packages {
        pids.push(rig.pid(package).await);
        rig.clock.advance(1);
    }
    rig.pid(&rig.package).await;
    settle().await;
    assert!(!alive(pids[0]), "the least used one stopped");
    assert!(pids[1..].iter().all(|pid| alive(*pid)));
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_sandbox_no_server_starts() {
    let rig = rig(|_| {});
    let host = host(&rig.root, &rig.temp, Arc::new(NoSandbox), rig.clock.clone(), rig.sleeper.clone());
    let refused = host.run(&rig.package, "echo", json!({}), Vec::new(), Duration::from_secs(5)).await;
    assert_eq!(refused, Err(ActionError::NotReady(SANDBOX_UNAVAILABLE.into())));
}

/// A Mac whose sandbox does not work.
struct NoSandbox;

impl Confinement for NoSandbox {
    fn command(&self, _spec: ConfineSpec) -> BoxFuture<'_, Result<Confined, ConfineError>> {
        Box::pin(std::future::ready(Err(ConfineError::Unavailable)))
    }
}

fn alive(pid: u64) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string()])
        .output()
        .is_ok_and(|output| output.status.success())
}
