//! One-shot command lines and the search for `claude`, with scripts standing
//! in for the user's shell and a temporary home: nobody's profile runs.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use eos_core::terminal::{ClaudeProgram, CommandEvents, CommandExit, ShellCommands};
use eos_kit_proc::{ProcessTrees, Runner};
use eos_platform::{PosixShell, kill_process_tree, process_alive};
use eos_pty::{ClaudeLocator, ShellRunner};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Stands in for the user's shell: `/bin/sh` without anybody's profile
/// (called as `<shell> -l -c <command>`).
static SH: LazyLock<PosixShell> = LazyLock::new(|| {
    let dir = tempfile::tempdir().expect("a folder").keep();
    let path = dir.join("plain-sh");
    std::fs::write(&path, "#!/bin/sh\nexec /bin/sh -c \"$3\"\n").expect("the script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("executable");
    PosixShell::fixed(path.to_string_lossy())
});

fn runner() -> Runner {
    Runner::new(ProcessTrees::new(eos_platform::isolate_command, |pid| kill_process_tree(pid).is_ok()))
}

#[derive(Debug, PartialEq)]
enum Got {
    Exit(CommandExit),
    Failed(String),
}

struct Sink {
    output: Arc<Mutex<Vec<u8>>>,
    done: UnboundedSender<Got>,
}

impl CommandEvents for Sink {
    fn output(&mut self, text: &str) {
        self.output.lock().expect("output").extend_from_slice(text.as_bytes());
    }
    fn exit(&mut self, exit: CommandExit) {
        let _ = self.done.send(Got::Exit(exit));
    }
    fn failed(&mut self, reason: String) {
        let _ = self.done.send(Got::Failed(reason));
    }
}

fn sink() -> (Box<Sink>, Arc<Mutex<Vec<u8>>>, UnboundedReceiver<Got>) {
    let output = Arc::new(Mutex::new(Vec::new()));
    let (done, rx) = unbounded_channel();
    (Box::new(Sink { output: output.clone(), done }), output, rx)
}

fn text(output: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&output.lock().expect("output")).into_owned()
}

const LONG: Duration = Duration::from_secs(60);

#[tokio::test]
async fn a_command_line_runs_with_both_streams_and_its_exit_code() {
    let dir = tempfile::tempdir().expect("a folder");
    let (events, output, mut done) = sink();
    let cwd = dir.path().canonicalize().expect("the folder");
    let _run = ShellRunner::new(runner(), &*SH, Some("/bin/sh".into())).run(
        &cwd.to_string_lossy(),
        "echo wire; echo problem >&2; pwd; exit 3",
        LONG,
        events,
    );
    let got = done.recv().await.expect("an end");
    assert_eq!(got, Got::Exit(CommandExit { code: Some(3), signal: None, timed_out: false }));
    let out = text(&output);
    assert!(out.starts_with("wire\nproblem\n"), "both streams, in the order written: {out}");
    assert!(out.contains(&*cwd.to_string_lossy()), "ran in the folder: {out}");
}

#[tokio::test]
async fn a_kill_ends_the_command_and_what_it_started() {
    let dir = tempfile::tempdir().expect("a folder");
    let (events, output, mut done) = sink();
    let run = ShellRunner::new(runner(), &*SH, Some("/bin/sh".into())).run(
        &dir.path().to_string_lossy(),
        "sleep 300 & echo $!; wait",
        LONG,
        events,
    );
    let grandchild: u32 = loop {
        if let Some(pid) = text(&output).lines().next().and_then(|l| l.trim().parse().ok()) {
            break pid;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(process_alive(grandchild));
    run.kill();
    let got = done.recv().await.expect("an end");
    assert_eq!(got, Got::Exit(CommandExit { code: None, signal: Some("SIGKILL".into()), timed_out: false }));
    for _ in 0..300 {
        if !process_alive(grandchild) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the command's own child outlived it");
}

#[tokio::test]
async fn a_command_past_its_deadline_is_ended() {
    let dir = tempfile::tempdir().expect("a folder");
    let (events, _output, mut done) = sink();
    let _run = ShellRunner::new(runner(), &*SH, Some("/bin/sh".into())).run(
        &dir.path().to_string_lossy(),
        "sleep 300",
        Duration::from_millis(200),
        events,
    );
    let got = done.recv().await.expect("an end");
    assert_eq!(got, Got::Exit(CommandExit { code: None, signal: Some("SIGKILL".into()), timed_out: true }));
}

#[tokio::test]
async fn a_folder_that_is_not_there_fails_the_start() {
    let (events, _output, mut done) = sink();
    let _run = ShellRunner::new(runner(), &*SH, Some("/bin/sh".into())).run(
        "/nonexistent/eos-pty-test",
        "echo hi",
        LONG,
        events,
    );
    assert!(matches!(done.recv().await, Some(Got::Failed(_))));
}

/// A script standing in for the user's shell: it answers `command -v claude`
/// with `answer` (nothing: not found).
fn fake_shell(dir: &Path, answer: &str) -> &'static PosixShell {
    let path = dir.join("shell");
    let body =
        if answer.is_empty() { "#!/bin/sh\nexit 1\n".to_owned() } else { format!("#!/bin/sh\necho '{answer}'\n") };
    std::fs::write(&path, body).expect("the script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("executable");
    Box::leak(Box::new(PosixShell::fixed(path.to_string_lossy())))
}

#[tokio::test]
async fn claude_is_found_through_the_users_shell() {
    let dir = tempfile::tempdir().expect("a folder");
    let shell = fake_shell(dir.path(), "/somewhere/bin/claude");
    let locator = ClaudeLocator::new(runner(), shell, Some(dir.path().to_owned()));
    // The shell finds it itself, so its own word for it is used.
    assert_eq!(locator.locate().await.as_deref(), Some("claude"));
}

#[tokio::test]
async fn claude_is_found_where_installers_put_it() {
    let dir = tempfile::tempdir().expect("a folder");
    let shell = fake_shell(dir.path(), "");
    let bin = dir.path().join(".local/bin");
    std::fs::create_dir_all(&bin).expect("the folder");
    std::fs::write(bin.join("claude"), "#!/bin/sh\n").expect("the program");
    let locator = ClaudeLocator::new(runner(), shell, Some(dir.path().to_owned()));
    // Present but not executable is not installed.
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o644)).expect("mode");
    // (the system-wide places may hold a real one on this computer)
    let system_wide = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].iter().any(|p| Path::new(p).exists());
    if !system_wide {
        assert_eq!(locator.locate().await, None);
    }
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).expect("mode");
    assert_eq!(locator.locate().await, Some(bin.join("claude").to_string_lossy().into_owned()));
}
