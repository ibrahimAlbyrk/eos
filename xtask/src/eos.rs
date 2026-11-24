//! `eos`: the owner's command for the installed app, run through the
//! launcher `scripts/eos` (`cargo xtask eos …` in this checkout).
//!
//! ```text
//! eos build [--no-open] [--identity <name | ->]   cargo xtask install
//! eos restore [--no-open]                          cargo xtask install --restore
//! eos start | stop | restart | status | help
//! eos logs [--path] [-n <lines>]
//! eos routines | run | once …                     the installed app's own `eos` command
//! ```
//!
//! `stop` asks the app to quit as its Quit menu does, the installer's own
//! quit; nothing is ever killed. `status` prints what the running app answers
//! to `Eos --status`.

use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};

use anyhow::{Context, bail};
use serde_json::Value;

use crate::install::quit::{self, Busy, QUIT_TIMEOUT};
use crate::install::system::{MacSystem, System};
use crate::install::{self, DEFAULT_DEST, Place};

const HELP: &str = "\
eos: build, run and check the Eos app from this checkout

usage:
  eos build [--no-open] [--identity <name | ->]
      build this checkout, install it as /Applications/Eos.app (the app it
      replaces is kept), link this command at ~/.local/bin/eos and open the app
  eos restore [--no-open]
      put the app the last build replaced back (run it again to come back)
  eos start      open the installed app
  eos stop       ask it to quit, as its Quit menu does
  eos restart    stop, then start
  eos status     what the running app reports (exits 1 when it is not running)
  eos logs [-n <lines>]
                 where the app's logs are, and the last lines (40) of its core and
                 shell logs
  eos logs --path
                 only the logs' folder
  eos routines | run | once …
                 the installed app's own command: start routines from here
                 (its usage: /Applications/Eos.app/Contents/Helpers/eos help)
  eos help       this text";

/// How many lines of each log `eos logs` shows unless told.
const TAIL_LINES: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    /// The arguments for `cargo xtask install`.
    Install(Vec<String>),
    Start,
    Stop,
    Restart,
    Status,
    Logs {
        path_only: bool,
        lines: usize,
    },
    Help,
    /// What the installed app's own command (`Contents/Helpers/eos`) answers.
    App(Vec<String>),
}

/// The commands the installed app's own `eos` takes.
const APP_COMMANDS: [&str; 3] = ["routines", "run", "once"];

/// Commands of the TypeScript `eos` that are not here, and what to use instead.
fn retired(name: &str) -> Option<&'static str> {
    Some(match name {
        "orchestrator" | "orch" | "chat" | "ls" | "list" | "spawn" | "show" | "info" | "kill" | "perm" => {
            "agents are run from the Eos app"
        }
        "config" => "settings are in the app (Settings), stored in ~/.eos/config.json",
        "doctor" => "use eos status",
        "prompts" => "preview one with: cargo run -p eos-store-files --example preview_prompt -- <orchestrator|worker>",
        _ => return None,
    })
}

/// Why the arguments are refused: one line for the person.
fn refuse(line: String) -> anyhow::Error {
    anyhow::anyhow!("{line}\nRun eos help for the commands.")
}

fn parse(args: &[String]) -> anyhow::Result<Command> {
    let Some((name, rest)) = args.split_first() else { return Ok(Command::Help) };
    let flags = |allowed: &[&str]| -> anyhow::Result<Vec<String>> {
        let mut out = Vec::new();
        let mut it = rest.iter();
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--no-open" if allowed.contains(&"--no-open") => out.push(arg.clone()),
                "--identity" if allowed.contains(&"--identity") => {
                    let value = it.next().ok_or_else(|| refuse("--identity needs a name, or - for ad hoc".into()))?;
                    out.extend([arg.clone(), value.clone()]);
                }
                "--app" => {
                    return Err(refuse(format!("{name} has no --app: eos build always builds the whole app")));
                }
                other => return Err(refuse(format!("{name} does not take {other}"))),
            }
        }
        Ok(out)
    };
    let bare = |command: Command| match rest.first() {
        Some(extra) => Err(refuse(format!("{name} takes no arguments (got {extra})"))),
        None => Ok(command),
    };
    match name.as_str() {
        "build" => Ok(Command::Install(flags(&["--no-open", "--identity"])?)),
        "restore" => {
            let mut args = vec!["--restore".to_owned()];
            args.extend(flags(&["--no-open"])?);
            Ok(Command::Install(args))
        }
        "start" => bare(Command::Start),
        "stop" => bare(Command::Stop),
        "restart" => bare(Command::Restart),
        "status" => bare(Command::Status),
        "logs" => logs_args(rest),
        "help" | "-h" | "--help" => Ok(Command::Help),
        app if APP_COMMANDS.contains(&app) => Ok(Command::App(args.to_vec())),
        other => Err(match retired(other) {
            Some(instead) => refuse(format!("{other} is not available: {instead}.")),
            None => refuse(format!("{other} is not available.")),
        }),
    }
}

fn logs_args(rest: &[String]) -> anyhow::Result<Command> {
    let (mut path_only, mut lines) = (false, TAIL_LINES);
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--path" => path_only = true,
            "-n" | "--lines" => {
                let value = it.next().ok_or_else(|| refuse(format!("{arg} needs a number of lines")))?;
                lines = value.parse().map_err(|_| refuse(format!("{arg} needs a number of lines, not {value}")))?;
            }
            other => {
                return Err(refuse(format!("logs does not take {other} (the app keeps one core and one shell log)")));
            }
        }
    }
    Ok(Command::Logs { path_only, lines })
}

/// Runs `eos <args>`; the process's exit code.
pub(crate) fn run(args: &[String]) -> anyhow::Result<i32> {
    let place = Place::of(PathBuf::from(DEFAULT_DEST));
    match parse(args)? {
        Command::Install(args) => install::run(&args).map(|()| 0),
        Command::Help => {
            println!("{HELP}");
            Ok(0)
        }
        Command::Logs { path_only, lines } => {
            let folder = logs_folder(&place);
            for line in logs(&folder, path_only, lines) {
                println!("{line}");
            }
            Ok(0)
        }
        Command::App(args) => forward(place.dest(), &args),
        command => {
            let (code, lines) = act(&command, &place, &MacSystem)?;
            for line in lines {
                println!("{line}");
            }
            Ok(code)
        }
    }
}

/// Runs the installed app's own command with the terminal's input and output; its exit code.
fn forward(dest: &Path, args: &[String]) -> anyhow::Result<i32> {
    installed(dest)?;
    let command = dest.join("Contents/Helpers/eos");
    if !command.is_file() {
        bail!("the Eos at {} has no eos command: build a newer one with eos build", dest.display());
    }
    let status =
        Process::new(&command).args(args).status().with_context(|| format!("could not run {}", command.display()))?;
    Ok(status.code().unwrap_or(130))
}

fn installed(dest: &Path) -> anyhow::Result<()> {
    if !dest.join("Contents/Info.plist").is_file() {
        bail!("Eos is not installed at {}: install it with eos build", dest.display());
    }
    Ok(())
}

/// The app-facing commands: the exit code and what to print.
fn act(command: &Command, place: &Place, system: &dyn System) -> anyhow::Result<(i32, Vec<String>)> {
    let dest = place.dest();
    installed(dest)?;
    let mut lines = Vec::new();
    match command {
        Command::Start => lines.push(start(place, system)?),
        Command::Stop => lines.push(stop(dest, system)?),
        Command::Restart => {
            lines.push(stop(dest, system)?);
            lines.push(start(place, system)?);
        }
        Command::Status => return status(dest),
        Command::Install(_) | Command::Help | Command::Logs { .. } | Command::App(_) => {}
    }
    Ok((0, lines))
}

fn start(place: &Place, system: &dyn System) -> anyhow::Result<String> {
    let dest = place.dest();
    let running = !system.apps_in(dest).is_empty();
    system.open(dest, place.named_home()).with_context(|| format!("could not open {}", dest.display()))?;
    Ok(if running { "Eos was running already: brought it to the front.".into() } else { "Opened Eos.".into() })
}

fn stop(dest: &Path, system: &dyn System) -> anyhow::Result<String> {
    if system.apps_in(dest).is_empty() {
        return Ok("Eos is not running.".into());
    }
    match quit::stop_everything_in(dest, system, false) {
        Ok(_) => Ok("Quit Eos.".into()),
        Err(Busy::Apps(_) | Busy::Daemon) => bail!(
            "Eos was asked to quit and still runs after {} s; it may be asking you something. Answer it, or quit it from its menu.",
            QUIT_TIMEOUT.as_secs()
        ),
        Err(Busy::Processes(left)) => {
            let list: Vec<String> = left.iter().map(|p| format!("  {} {}", p.pid, p.executable)).collect();
            bail!("Eos quit, but these still run from {}:\n{}", dest.display(), list.join("\n"))
        }
    }
}

/// The installed app's logs (`eos_bridge::launch::logs_folder`): what the running app
/// says, else the shell's default data folder's `logs/`, or the named data folder's.
fn logs_folder(place: &Place) -> PathBuf {
    let exe = place.dest().join("Contents/MacOS/Eos");
    let told = Process::new(&exe)
        .arg("--status")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.lines().rev().find_map(|line| serde_json::from_str::<Value>(line).ok())
        })
        .and_then(|answer| answer["logs"]["folder"].as_str().map(PathBuf::from));
    if let Some(folder) = told {
        return folder;
    }
    match place.named_home() {
        Some(home) => home.join("logs"),
        None => default_logs(eos_platform::home_dir().as_deref().unwrap_or(Path::new("/"))),
    }
}

fn default_logs(user_home: &Path) -> PathBuf {
    user_home.join("Library/Application Support/com.ibrahimalbyrk.eos/logs")
}

/// The newest file of a log: the live one, or the last rotated one when the live one is empty.
fn newest(folder: &Path, name: &str) -> Option<PathBuf> {
    [folder.join(name), folder.join(format!("{name}.1"))]
        .into_iter()
        .find(|path| fs_len(path).is_some_and(|len| len > 0))
}

fn fs_len(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// The last `count` lines of a file, reading at most its last megabyte.
fn tail(path: &Path, count: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    let len = file.metadata().map_or(0, |m| m.len());
    let start = len.saturating_sub(1 << 20);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    // A read that starts mid-file starts mid-line: that line is dropped.
    let whole = if start > 0 { lines.get(1..).unwrap_or_default() } else { &lines[..] };
    whole[whole.len().saturating_sub(count)..].iter().map(|l| (*l).to_owned()).collect()
}

/// What `eos logs` prints.
fn logs(folder: &Path, path_only: bool, count: usize) -> Vec<String> {
    let mut out = vec![folder.display().to_string()];
    if path_only {
        return out;
    }
    for name in ["core.log", "shell.log"] {
        out.push(String::new());
        match newest(folder, name) {
            Some(path) => {
                out.push(format!("==> {} <==", path.display()));
                out.extend(tail(&path, count));
            }
            None => out.push(format!("(no {name} yet)")),
        }
    }
    out
}

/// What `Eos --status` answers, put plainly; exit code 1 when it is not running.
fn status(dest: &Path) -> anyhow::Result<(i32, Vec<String>)> {
    let exe = dest.join("Contents/MacOS/Eos");
    let out = Process::new(&exe)
        .arg("--status")
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("could not run {}", exe.display()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let answer: Value = text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .with_context(|| format!("Eos --status answered nothing readable ({}): {}", out.status, text.trim()))?;
    if answer["running"] != true {
        return Ok((1, vec!["Eos is not running.".into()]));
    }
    let mut summary = String::from("Eos");
    if let Some(version) = answer["version"].as_str() {
        summary.push_str(&format!(" {version}"));
    }
    summary.push_str(" is running");
    if let Some(pid) = answer["pid"].as_u64() {
        summary.push_str(&format!(" (process {pid})"));
    }
    summary.push_str(match answer["window"]["visible"].as_bool() {
        Some(true) => ", its window is open.",
        Some(false) => ", its window is hidden.",
        None => ".",
    });
    let details = serde_json::to_string_pretty(&answer).unwrap_or_default();
    let mut lines = vec![summary];
    if let Some(folder) = answer["logs"]["folder"].as_str() {
        lines.push(format!("Its logs are in {folder} (eos logs shows their last lines)."));
    }
    lines.push(details);
    Ok((0, lines))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::install::quit::tests::FakeSystem;

    fn args(list: &[&str]) -> anyhow::Result<Command> {
        parse(&list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
    }

    fn refusal(list: &[&str]) -> String {
        args(list).expect_err("refused").to_string()
    }

    #[test]
    fn the_commands_and_their_flags_are_read() {
        assert_eq!(args(&[]).expect("help"), Command::Help);
        for help in ["help", "-h", "--help"] {
            assert_eq!(args(&[help]).expect("help"), Command::Help);
        }
        assert_eq!(args(&["build"]).expect("build"), Command::Install(vec![]));
        let flags = args(&["build", "--no-open", "--identity", "-"]).expect("build");
        assert_eq!(flags, Command::Install(vec!["--no-open".into(), "--identity".into(), "-".into()]));
        assert_eq!(
            args(&["restore", "--no-open"]).expect("restore"),
            Command::Install(vec!["--restore".into(), "--no-open".into()])
        );
        assert_eq!(args(&["start"]).expect("start"), Command::Start);
        assert_eq!(args(&["stop"]).expect("stop"), Command::Stop);
        assert_eq!(args(&["restart"]).expect("restart"), Command::Restart);
        assert_eq!(args(&["status"]).expect("status"), Command::Status);
        assert_eq!(args(&["logs"]).expect("logs"), Command::Logs { path_only: false, lines: TAIL_LINES });
        assert_eq!(args(&["logs", "--path"]).expect("logs"), Command::Logs { path_only: true, lines: TAIL_LINES });
        assert_eq!(args(&["logs", "-n", "5"]).expect("logs"), Command::Logs { path_only: false, lines: 5 });
        let run = args(&["run", "pr-review", "482", "--wait"]).expect("run");
        assert_eq!(run, Command::App(vec!["run".into(), "pr-review".into(), "482".into(), "--wait".into()]));
        assert_eq!(args(&["routines"]).expect("routines"), Command::App(vec!["routines".into()]));
    }

    #[test]
    fn logs_prints_the_folder_and_the_newest_lines_of_both_logs() {
        let tmp = tempfile::tempdir().expect("tmp");
        let folder = tmp.path().join("logs");
        fs::create_dir_all(&folder).expect("folder");
        let core: String = (1..=100).map(|n| format!("core line {n}\n")).collect();
        fs::write(folder.join("core.log"), core).expect("core");
        // A shell log just rotated: the live file is empty, the newest lines are in .1.
        fs::write(folder.join("shell.log"), "").expect("shell");
        fs::write(folder.join("shell.log.1"), "shell a\nshell b\n").expect("shell.1");

        assert_eq!(logs(&folder, true, 3), [folder.display().to_string()]);
        let out = logs(&folder, false, 3);
        assert_eq!(out[0], folder.display().to_string());
        let core_at = out.iter().position(|l| l.ends_with("core.log <==")).expect("core header");
        assert_eq!(out[core_at + 1..core_at + 4], ["core line 98", "core line 99", "core line 100"]);
        let shell_at = out.iter().position(|l| l.ends_with("shell.log.1 <==")).expect("shell header");
        assert_eq!(out[shell_at + 1..], ["shell a", "shell b"]);

        let empty = tmp.path().join("none");
        assert!(logs(&empty, false, 3).contains(&"(no core.log yet)".to_owned()));
        assert_eq!(
            default_logs(Path::new("/Users/me")),
            Path::new("/Users/me/Library/Application Support/com.ibrahimalbyrk.eos/logs")
        );
    }

    #[test]
    fn logs_asks_the_running_app_where_its_logs_are() {
        let tmp = tempfile::tempdir().expect("tmp");
        let answer = r#"{"running":true,"logs":{"folder":"/tmp/eos-run/logs"}}"#;
        let app = fake_app(&tmp.path().join("a"), answer);
        assert_eq!(logs_folder(&place(&app, tmp.path())), Path::new("/tmp/eos-run/logs"));
        // Not running and on another data folder: that folder's logs.
        let app = fake_app(&tmp.path().join("b"), r#"{"running":false}"#);
        assert_eq!(logs_folder(&place(&app, &tmp.path().join("data"))), tmp.path().join("data/logs"));
    }

    #[test]
    fn what_is_not_a_command_or_a_flag_of_it_is_refused_with_what_to_use() {
        assert!(refusal(&["build", "--app"]).contains("no --app"));
        assert!(refusal(&["build", "--dest", "/tmp/Eos.app"]).contains("does not take --dest"));
        assert!(refusal(&["build", "--identity"]).contains("needs a name"));
        assert!(refusal(&["restore", "--identity", "-"]).contains("does not take --identity"));
        assert!(refusal(&["status", "--json"]).contains("takes no arguments"));
        assert!(refusal(&["chat", "hi"]).starts_with("chat is not available: agents are run from the Eos app."));
        assert!(refusal(&["logs", "w-1"]).contains("logs does not take w-1"));
        assert!(refusal(&["logs", "-n"]).contains("needs a number"));
        assert!(refusal(&["logs", "-n", "many"]).contains("not many"));
        assert!(refusal(&["doctor"]).contains("eos status"));
        let unknown = refusal(&["frobnicate"]);
        assert_eq!(unknown.lines().next(), Some("frobnicate is not available."));
        assert!(unknown.contains("eos help"));
    }

    /// A stand-in app: `Contents/MacOS/Eos` prints `answer` for `--status`.
    fn fake_app(dir: &Path, answer: &str) -> PathBuf {
        let app = dir.join("Eos.app");
        fs::create_dir_all(app.join("Contents/MacOS")).expect("bundle");
        fs::write(app.join("Contents/Info.plist"), "<plist/>").expect("plist");
        let exe = app.join("Contents/MacOS/Eos");
        fs::write(&exe, format!("#!/bin/sh\n[ \"$1\" = --status ] || exit 2\necho '{answer}'\n")).expect("exe");
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).expect("mode");
        app
    }

    fn place(app: &Path, home: &Path) -> Place {
        Place::new(app.to_owned(), home.to_owned(), None)
    }

    #[test]
    fn start_opens_the_app_and_stop_asks_it_to_quit() {
        let tmp = tempfile::tempdir().expect("tmp");
        let app = fake_app(tmp.path(), "{}");
        let place = place(&app, &tmp.path().join("home"));

        let idle = FakeSystem::new(false);
        assert_eq!(act(&Command::Start, &place, &idle).expect("starts"), (0, vec!["Opened Eos.".to_owned()]));
        assert_eq!(act(&Command::Stop, &place, &idle).expect("stops").1, ["Eos is not running."]);

        let running = FakeSystem::new(true);
        assert_eq!(act(&Command::Stop, &place, &running).expect("stops").1, ["Quit Eos."]);
        let calls = running.calls();
        assert_eq!(calls[..3], ["apps", "quit 4242", "apps"]);
        assert!(!calls.contains(&"stop daemon".to_owned()), "only the app is quit: {calls:?}");

        let restarted = FakeSystem::new(true);
        let (_, lines) = act(&Command::Restart, &place, &restarted).expect("restarts");
        assert_eq!(lines, ["Quit Eos.", "Opened Eos."]);
        assert!(restarted.calls().last().is_some_and(|c| c.starts_with(&format!("open {}", app.display()))));
    }

    #[test]
    fn an_app_that_does_not_quit_is_reported_and_never_killed() {
        let tmp = tempfile::tempdir().expect("tmp");
        let app = fake_app(tmp.path(), "{}");
        let stuck = FakeSystem { quits_after: None, ..FakeSystem::new(true) };
        let error = act(&Command::Restart, &place(&app, tmp.path()), &stuck).expect_err("busy");
        assert!(error.to_string().contains("still runs"), "{error}");
        assert!(!stuck.calls().iter().any(|c| c.starts_with("open")), "not opened again");
    }

    #[test]
    fn status_reports_the_running_app_and_says_plainly_when_it_is_not() {
        let tmp = tempfile::tempdir().expect("tmp");
        let running = r#"{"running":true,"pid":4242,"version":"0.2.0","window":{"visible":true}}"#;
        let app = fake_app(&tmp.path().join("a"), running);
        let (code, lines) = act(&Command::Status, &place(&app, tmp.path()), &FakeSystem::new(true)).expect("status");
        assert_eq!(code, 0);
        assert_eq!(lines[0], "Eos 0.2.0 is running (process 4242), its window is open.");
        assert!(lines.last().is_some_and(|l| l.contains("\"pid\": 4242")));

        let app = fake_app(&tmp.path().join("b"), r#"{"running":false}"#);
        let answer = act(&Command::Status, &place(&app, tmp.path()), &FakeSystem::new(false)).expect("status");
        assert_eq!(answer, (1, vec!["Eos is not running.".to_owned()]));
    }

    #[test]
    fn an_app_that_is_not_installed_says_how_to_install_it() {
        let tmp = tempfile::tempdir().expect("tmp");
        let missing = place(&tmp.path().join("Eos.app"), tmp.path());
        for command in [Command::Start, Command::Stop, Command::Restart, Command::Status] {
            let error = act(&command, &missing, &FakeSystem::new(false)).expect_err("missing");
            assert!(error.to_string().contains("install it with eos build"), "{error}");
        }
    }
}
