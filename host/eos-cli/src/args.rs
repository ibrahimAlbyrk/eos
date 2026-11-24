//! The command line, read into the request the app's gateway takes.

use std::collections::BTreeMap;
use std::path::Path;

use eos_contracts::cli::{CliOnce, CliRequest, CliRun};

pub const HELP: &str = "\
eos: start Eos routines from a terminal.

  eos routines [--json]
  eos run <routine> [item…] [--file <path>]… [--note <text>] [--option <name=value>]…
          [--show-only] [--at <when>] [--wait] [--yes] [--json]
  eos once \"<what to do>\" [--file <path>]… [--show-only] [--wait] [--json]
  eos halt       stop every routine from starting and sending
  eos resume     let them go on
  eos memory hook --event <name>
                 for Claude Code's hooks: the hook's input on standard input, what Eos
                 remembers about it on standard output; nothing after 300 ms
  eos help

Text piped in becomes one more item. --wait shows the run's progress and prints its
result; Ctrl-C stops waiting and the run goes on. --at takes a time with its zone, like
2026-11-19T09:00+01:00.";

/// What the command line asks.
#[derive(Debug, Clone, PartialEq)]
pub enum Asked {
    Help,
    /// A request for the app. `stdin`: whether piped text belongs to it.
    Request {
        request: CliRequest,
        stdin: bool,
    },
    /// `eos memory hook --event <name>`: answered within 300 ms or not at all.
    MemoryHook {
        event: String,
    },
}

/// Reads the arguments (without the program name). Relative paths are taken from `cwd`.
/// `Err`: why the line cannot be read, for standard error.
pub fn parse(args: &[String], cwd: &Path) -> Result<Asked, String> {
    let Some((command, rest)) = args.split_first() else { return Ok(Asked::Help) };
    let mut flags = Flags::read(rest, cwd)?;
    let asked = match command.as_str() {
        "help" | "--help" | "-h" => return Ok(Asked::Help),
        "halt" | "resume" => {
            flags.done(0)?;
            if command == "halt" { CliRequest::Halt } else { CliRequest::Resume }
        }
        "memory" => {
            let event = flags.take_value("--event").ok_or("eos memory hook needs --event <name>")?;
            if flags.words.first().map(String::as_str) != Some("hook") {
                return Err("eos memory takes one command: eos memory hook --event <name>".into());
            }
            flags.words.remove(0);
            flags.done(0)?;
            return Ok(Asked::MemoryHook { event });
        }
        "routines" => {
            let json = flags.take_switch("--json");
            flags.done(0)?;
            CliRequest::Routines { json }
        }
        "run" => {
            let mut words = std::mem::take(&mut flags.words).into_iter();
            let routine = words.next().ok_or("eos run needs a routine: eos run <routine> [item…]")?;
            let run = CliRun {
                routine,
                items: words.collect(),
                files: std::mem::take(&mut flags.files),
                stdin: None,
                note: flags.take_value("--note"),
                options: std::mem::take(&mut flags.options),
                show_only: flags.take_switch("--show-only"),
                at: flags.take_value("--at"),
                wait: flags.take_switch("--wait"),
                yes: flags.take_switch("--yes"),
                json: flags.take_switch("--json"),
            };
            flags.done(0)?;
            return Ok(Asked::Request { request: CliRequest::Run(run), stdin: true });
        }
        "once" => {
            let what = flags.words.join(" ");
            if what.trim().is_empty() {
                return Err("eos once needs what to do: eos once \"<what to do>\"".into());
            }
            let once = CliOnce {
                what,
                files: std::mem::take(&mut flags.files),
                stdin: None,
                show_only: flags.take_switch("--show-only"),
                wait: flags.take_switch("--wait"),
                json: flags.take_switch("--json"),
            };
            flags.words.clear();
            flags.done(0)?;
            return Ok(Asked::Request { request: CliRequest::Once(once), stdin: true });
        }
        other => return Err(format!("eos does not know `{other}`. `eos help` lists the commands.")),
    };
    Ok(Asked::Request { request: asked, stdin: false })
}

/// The words and flags after the command.
#[derive(Debug, Default)]
struct Flags {
    words: Vec<String>,
    files: Vec<String>,
    options: BTreeMap<String, String>,
    switches: Vec<String>,
    values: Vec<(String, String)>,
}

const SWITCHES: [&str; 4] = ["--json", "--show-only", "--wait", "--yes"];
const VALUES: [&str; 3] = ["--note", "--at", "--event"];

impl Flags {
    fn read(args: &[String], cwd: &Path) -> Result<Self, String> {
        let mut flags = Flags::default();
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            let mut value = || args.next().cloned().ok_or_else(|| format!("{arg} needs a value"));
            match arg.as_str() {
                "--file" => flags.files.push(cwd.join(value()?).to_string_lossy().into_owned()),
                "--option" => {
                    let given = value()?;
                    let (name, v) = given.split_once('=').ok_or("--option takes name=value")?;
                    flags.options.insert(name.to_owned(), v.to_owned());
                }
                a if VALUES.contains(&a) => flags.values.push((a.to_owned(), value()?)),
                a if SWITCHES.contains(&a) => flags.switches.push(a.to_owned()),
                "--" => flags.words.extend(args.by_ref().cloned()),
                a if a.starts_with("--") => return Err(format!("eos does not know {a}. `eos help` lists the flags.")),
                _ => flags.words.push(arg.clone()),
            }
        }
        Ok(flags)
    }

    fn take_switch(&mut self, name: &str) -> bool {
        let had = self.switches.iter().any(|s| s == name);
        self.switches.retain(|s| s != name);
        had
    }

    fn take_value(&mut self, name: &str) -> Option<String> {
        let at = self.values.iter().position(|(k, _)| k == name)?;
        Some(self.values.remove(at).1)
    }

    /// Fails on what the command did not take.
    fn done(self, words: usize) -> Result<(), String> {
        let left = self.switches.into_iter().chain(self.values.into_iter().map(|(k, _)| k)).next().or_else(|| {
            (!self.files.is_empty()).then(|| "--file".into()).or((!self.options.is_empty()).then(|| "--option".into()))
        });
        if let Some(flag) = left {
            return Err(format!("{flag} does not go with this command"));
        }
        if self.words.len() > words {
            return Err(format!("unexpected `{}`", self.words[words]));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(line: &[&str]) -> Result<Asked, String> {
        let args: Vec<String> = line.iter().map(|s| (*s).to_owned()).collect();
        parse(&args, Path::new("/work"))
    }

    fn request(line: &[&str]) -> CliRequest {
        match read(line) {
            Ok(Asked::Request { request, .. }) => request,
            other => panic!("{line:?}: {other:?}"),
        }
    }

    #[test]
    fn a_run_line_reads_into_its_request() {
        let CliRequest::Run(run) = request(&[
            "run",
            "pr-review",
            "482",
            "483",
            "--file",
            "notes.md",
            "--note",
            "be brief",
            "--option",
            "depth=deep",
            "--show-only",
            "--at",
            "2026-11-19T09:00+01:00",
            "--wait",
            "--yes",
            "--json",
        ]) else {
            panic!("a run")
        };
        assert_eq!(
            (run.routine.as_str(), run.items.as_slice()),
            ("pr-review", &["482".to_owned(), "483".to_owned()][..])
        );
        assert_eq!(run.files, ["/work/notes.md"]);
        assert_eq!((run.note.as_deref(), run.options["depth"].as_str()), (Some("be brief"), "deep"));
        assert!(run.show_only && run.wait && run.yes && run.json);
        assert_eq!(run.at.as_deref(), Some("2026-11-19T09:00+01:00"));
        let CliRequest::Run(absolute) = request(&["run", "x", "--file", "/tmp/a"]) else { panic!("a run") };
        assert_eq!(absolute.files, ["/tmp/a"]);
    }

    #[test]
    fn once_routines_and_help() {
        let CliRequest::Once(once) = request(&["once", "Tidy", "my downloads", "--wait"]) else { panic!("once") };
        assert_eq!((once.what.as_str(), once.wait), ("Tidy my downloads", true));
        assert_eq!(request(&["routines", "--json"]), CliRequest::Routines { json: true });
        assert_eq!(request(&["halt"]), CliRequest::Halt);
        assert_eq!(request(&["resume"]), CliRequest::Resume);
        assert_eq!(
            read(&["memory", "hook", "--event", "PreToolUse"]),
            Ok(Asked::MemoryHook { event: "PreToolUse".into() })
        );
        assert!(read(&["memory", "--event", "x"]).is_err());
        assert!(read(&["memory", "hook"]).is_err());
        assert_eq!(read(&[]), Ok(Asked::Help));
        assert_eq!(read(&["help"]), Ok(Asked::Help));
    }

    #[test]
    fn a_line_it_cannot_read_says_why() {
        for line in [
            &["dance"][..],
            &["run"],
            &["once"],
            &["run", "x", "--colour"],
            &["run", "x", "--note"],
            &["run", "x", "--option", "depth"],
            &["routines", "--wait"],
            &["routines", "extra"],
        ] {
            assert!(read(line).is_err(), "{line:?}");
        }
    }
}
