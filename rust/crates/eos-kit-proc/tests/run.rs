//! Real short-lived processes: bounds, process trees, and nothing left behind.

use std::time::{Duration, Instant};

use eos_kit_proc::{Command, Env, Error, Event, Overflow, ProcessTrees, Runner};
use eos_platform::{kill_process_tree, process_alive};

fn runner() -> Runner {
    Runner::new(ProcessTrees::new(eos_platform::isolate_command, |pid| kill_process_tree(pid).is_ok()))
}

/// Processes still in the group the child led (zombies not counted).
fn group_members(pgid: u32) -> Vec<String> {
    let out = std::process::Command::new("/bin/ps").args(["-axo", "pgid=,stat=,pid=,command="]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| {
            let mut fields = line.split_whitespace();
            fields.next() == Some(pgid.to_string().as_str()) && fields.next().is_some_and(|stat| !stat.starts_with('Z'))
        })
        .map(str::to_owned)
        .collect()
}

/// Nothing is left of a killed tree, including a process forked while the signal went out.
async fn tree_is_empty(pgid: u32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let left = group_members(pgid);
        if left.is_empty() {
            return;
        }
        assert!(Instant::now() < deadline, "still in the tree: {left:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn sh(line: &str) -> Command {
    Command::shell("/bin/sh", line)
}

/// `ps`'s state letter for a process; empty when it is gone. A zombie is `Z`.
fn state(pid: u32) -> String {
    let out = std::process::Command::new("/bin/ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

async fn gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

fn first_number(bytes: &[u8]) -> u32 {
    String::from_utf8_lossy(bytes).split_whitespace().next().and_then(|w| w.parse().ok()).expect("a pid")
}

#[tokio::test]
async fn output_exit_code_and_stdin_are_captured() {
    let out = runner().run(sh("echo out; echo err >&2; exit 3")).await.expect("run");
    assert_eq!((out.stdout_text().as_str(), out.stderr_text().as_str()), ("out\n", "err\n"));
    assert_eq!(out.exit_code, Some(3));
    assert!(!out.success() && !out.timed_out && !out.stdout_truncated);

    let out = runner().run(Command::new("/bin/cat").stdin("fed through stdin")).await.expect("run");
    assert_eq!(out.stdout_text(), "fed through stdin");
    assert!(out.success());

    // Without input, stdin is at end-of-file: a command that reads it does not hang.
    let out = runner().run(Command::new("/bin/cat").timeout(Duration::from_secs(5))).await.expect("run");
    assert!(out.success() && out.stdout.is_empty());
}

#[tokio::test]
async fn the_working_folder_is_the_one_asked_for() {
    let dir = tempfile::tempdir().expect("dir");
    let real = std::fs::canonicalize(dir.path()).expect("real");
    let out = runner().run(sh("pwd -P").cwd(dir.path())).await.expect("run");
    assert_eq!(out.stdout_text().trim(), real.to_string_lossy());
}

#[tokio::test]
async fn a_program_that_is_not_there_is_a_spawn_error() {
    let err = runner().run(Command::new("/no/such/eos-program")).await.expect_err("fails");
    assert!(matches!(&err, Error::Spawn { source, .. } if source.kind() == std::io::ErrorKind::NotFound), "{err}");
}

#[tokio::test]
async fn the_child_sees_exactly_the_environment_described() {
    let env = Env::only(["PATH"]).set("EOS_TEST_VISIBLE", "yes").without("HOME");
    let out = runner().run(sh("env").env(env)).await.expect("run");
    let text = out.stdout_text();
    let names: Vec<&str> = text.lines().filter_map(|l| l.split_once('=')).map(|(k, _)| k).collect();
    assert!(names.contains(&"PATH") && names.contains(&"EOS_TEST_VISIBLE"));
    assert!(!names.contains(&"HOME") && !names.contains(&"USER"), "{names:?}");

    let scrubbed = Env::inherit().without("PATH").without_prefix("EOS_TEST_");
    let out = runner().run(Command::new("/usr/bin/env").env(scrubbed)).await.expect("run");
    assert!(!out.stdout_text().lines().any(|l| l.starts_with("PATH=")));
}

#[tokio::test]
async fn a_timeout_ends_the_whole_tree_keeps_the_output_and_leaves_no_zombie() {
    let started = Instant::now();
    // The shell backgrounds a grandchild, prints its id, then hangs.
    let out = runner()
        .run(sh("sleep 30 & echo $!; echo partial; sleep 30").timeout(Duration::from_millis(300)))
        .await
        .expect("a timeout is a result, not an error");
    assert!(out.timed_out);
    assert_eq!(out.exit_code, None, "ended by a signal");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(out.stdout_text().contains("partial"), "what was printed before the deadline is kept");
    let grandchild = first_number(&out.stdout);
    assert!(gone(grandchild).await, "the grandchild died with the tree");
    assert_eq!(state(out.pid), "", "the shell was reaped, not left a zombie");
    tree_is_empty(out.pid).await;
}

#[tokio::test]
async fn dropping_the_run_ends_the_tree() {
    let dir = tempfile::tempdir().expect("dir");
    let pid_file = dir.path().join("pid");
    let line = format!("sleep 30 & echo $! > {}; sleep 30", pid_file.display());
    let task = tokio::spawn(async move { runner().run(sh(&line).no_timeout()).await });
    let grandchild = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file).ok().and_then(|s| s.trim().parse::<u32>().ok()) {
            break pid;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(process_alive(grandchild));
    task.abort();
    assert!(gone(grandchild).await, "cancelling the caller ended the grandchild");
}

#[tokio::test]
async fn output_past_the_cap_is_dropped_and_the_command_still_finishes() {
    let out = runner()
        .run(sh("head -c 3000000 /dev/zero; echo done >&2").max_output(64 * 1024, Overflow::Truncate))
        .await
        .expect("run");
    assert_eq!(out.stdout.len(), 64 * 1024);
    assert!(out.stdout_truncated && !out.stderr_truncated);
    assert_eq!(out.stderr_text(), "done\n", "the command ran to its end");
    assert!(out.success());
}

#[tokio::test]
async fn output_past_the_cap_can_fail_the_command_instead() {
    let started = Instant::now();
    let err =
        runner().run(sh("yes").no_timeout().max_output(64 * 1024, Overflow::Fail)).await.expect_err("too much output");
    assert!(matches!(err, Error::OutputTooLarge { limit } if limit == 64 * 1024));
    assert!(started.elapsed() < Duration::from_secs(5), "it did not wait for `yes` to finish");
}

#[tokio::test]
async fn a_signal_exit_has_no_code() {
    let out = runner().run(sh("kill -TERM $$")).await.expect("run");
    assert_eq!(out.exit_code, None);
    assert!(!out.timed_out);
}

#[tokio::test]
async fn a_background_process_holding_the_pipe_does_not_hold_the_result() {
    let started = Instant::now();
    let out = runner().run(sh("sleep 20 & echo started")).await.expect("run");
    assert!(out.success());
    assert_eq!(out.stdout_text(), "started\n");
    assert!(started.elapsed() < Duration::from_secs(5), "the result came when the shell exited");
    // The shell exited on its own: what it left running is the caller's to end.
    let _ = kill_process_tree(out.pid);
    tree_is_empty(out.pid).await;
}

#[tokio::test]
async fn streamed_output_arrives_in_order_before_the_exit() {
    let mut child = runner()
        .spawn(sh("for i in 1 2 3; do echo line $i; sleep 0.05; done; echo oops >&2; exit 7"))
        .await
        .expect("spawn");
    let (mut stdout, mut stderr, mut exit) = (Vec::new(), Vec::new(), None);
    let mut chunks = 0;
    while let Some(event) = child.next().await {
        assert!(exit.is_none(), "exit is the last event");
        match event {
            Event::Stdout(bytes) => {
                chunks += 1;
                stdout.extend(bytes);
            }
            Event::Stderr(bytes) => stderr.extend(bytes),
            Event::Exit(e) => exit = Some(e),
        }
    }
    assert_eq!(String::from_utf8_lossy(&stdout), "line 1\nline 2\nline 3\n");
    assert_eq!(String::from_utf8_lossy(&stderr), "oops\n");
    assert!(chunks >= 2, "output arrived while the command was still running");
    let exit = exit.expect("an exit");
    assert_eq!((exit.code, exit.timed_out), (Some(7), false));
}

#[tokio::test]
async fn an_open_stdin_carries_a_conversation_and_closing_it_ends_the_input() {
    let mut child = runner()
        .spawn(sh("while read line; do echo \"got $line\"; done; echo bye").stdin_open())
        .await
        .expect("spawns");
    let mut stdin = child.stdin().expect("the pipe");
    assert!(child.stdin().is_none(), "taken once");

    stdin.write(b"one\n").await.expect("writes");
    assert_eq!(child.next().await, Some(Event::Stdout(b"got one\n".to_vec())));
    stdin.write(b"two\n").await.expect("writes");
    assert_eq!(child.next().await, Some(Event::Stdout(b"got two\n".to_vec())));

    drop(stdin);
    assert_eq!(child.next().await, Some(Event::Stdout(b"bye\n".to_vec())));
    assert_eq!(child.next().await, Some(Event::Exit(eos_kit_proc::Exit { code: Some(0), timed_out: false })));
}

#[tokio::test]
async fn a_slow_consumer_loses_nothing() {
    // 4 MB through a queue that holds 512 KB: the child has to wait for the consumer.
    let mut child =
        runner().spawn(sh("head -c 4000000 /dev/zero").timeout(Duration::from_secs(30))).await.expect("spawn");
    let mut total = 0usize;
    let mut exit = None;
    while let Some(event) = child.next().await {
        match event {
            Event::Stdout(bytes) => {
                total += bytes.len();
                if total < 1_000_000 {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
            Event::Stderr(_) => {}
            Event::Exit(e) => exit = Some(e),
        }
    }
    assert_eq!(total, 4_000_000);
    assert_eq!(exit.map(|e| e.code), Some(Some(0)));
}

#[tokio::test]
async fn killing_or_dropping_a_streamed_child_ends_its_tree() {
    let mut child = runner().spawn(sh("sleep 30 & echo $!; sleep 30").no_timeout()).await.expect("spawn");
    let Some(Event::Stdout(first)) = child.next().await else { panic!("expected the grandchild's id") };
    let grandchild = first_number(&first);
    child.kill();
    let mut exit = None;
    while let Some(event) = child.next().await {
        if let Event::Exit(e) = event {
            exit = Some(e);
        }
    }
    assert_eq!(exit.map(|e| (e.code, e.timed_out)), Some((None, false)));
    assert!(gone(grandchild).await);
    tree_is_empty(child.pid()).await;

    let mut child = runner().spawn(sh("sleep 30 & echo $!; sleep 30").no_timeout()).await.expect("spawn");
    let Some(Event::Stdout(first)) = child.next().await else { panic!("expected the grandchild's id") };
    let (pid, grandchild) = (child.pid(), first_number(&first));
    drop(child);
    assert!(gone(grandchild).await && gone(pid).await, "dropping the handle ended the tree");
    tree_is_empty(pid).await;
}

#[tokio::test]
async fn many_runs_leave_no_zombies() {
    let runner = runner();
    let mut pids = Vec::new();
    for i in 0..40 {
        let command = if i % 4 == 0 { sh("sleep 30").timeout(Duration::from_millis(20)) } else { sh("true") };
        pids.push(runner.run(command).await.expect("run").pid);
    }
    let left: Vec<(u32, String)> =
        pids.into_iter().map(|pid| (pid, state(pid))).filter(|(_, s)| !s.is_empty()).collect();
    assert!(left.is_empty(), "children still in the process table: {left:?}");
}

// The shell is killed while it forks its next command: the process born in
// that instant is not hit by the first signal.
#[tokio::test]
async fn a_process_forked_while_the_tree_is_killed_does_not_escape() {
    for _ in 0..25 {
        let mut child = runner().spawn(sh("echo go; sleep 30; sleep 30").no_timeout()).await.expect("spawn");
        let Some(Event::Stdout(_)) = child.next().await else { panic!("expected output") };
        let pid = child.pid();
        drop(child);
        assert!(gone(pid).await);
        tree_is_empty(pid).await;
    }
}
