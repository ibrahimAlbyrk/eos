//! Running one command and reading its end the way today's code did.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use eos_kit_proc::{Command, Env, Overflow};

use crate::Git;

/// Output kept of an ordinary command.
pub(crate) const DEFAULT_CAP: usize = 4 * 1024 * 1024;
/// A whole tree or a whole commit as one patch.
pub(crate) const PATCH_CAP: usize = 32 * 1024 * 1024;
/// Commands that talk to a remote may wait on the network.
pub(crate) const REMOTE_TIMEOUT: Duration = Duration::from_secs(600);
/// What a command that printed more than its cap failed with (Node's words).
const TOO_LARGE: &str = "stdout maxBuffer length exceeded";

/// A command that exited 0.
#[derive(Debug)]
pub(crate) struct Ran {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}

impl Ran {
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// A command that did not exit 0: a non-zero status, a signal, a timeout,
/// more output than the cap, or a program that could not be started.
#[derive(Debug)]
pub(crate) struct Failed {
    /// `None` when there was no exit status.
    pub(crate) code: Option<i32>,
    pub(crate) stdout: String,
    /// `None` when the program never ran.
    pub(crate) stderr: Option<String>,
    /// `Command failed: <program> <args…>`, then stderr on the next lines.
    pub(crate) message: String,
}

impl Failed {
    /// What the program said on stderr, or why it never ran.
    pub(crate) fn stderr_or_message(&self) -> &str {
        self.stderr.as_deref().unwrap_or(&self.message)
    }

    /// The first non-empty line of what git said.
    pub(crate) fn first_line(&self) -> String {
        first_line(self.stderr_or_message())
    }

    /// The command printed more than its cap and was ended.
    pub(crate) fn is_too_large(&self) -> bool {
        self.code.is_none() && self.message == TOO_LARGE
    }

    /// git's message, trimmed; the command line when git said nothing.
    pub(crate) fn detail(&self) -> String {
        match self.stderr.as_deref().map(str::trim) {
            Some(stderr) if !stderr.is_empty() => stderr.to_owned(),
            _ => self.message.clone(),
        }
    }
}

pub(crate) fn first_line(text: &str) -> String {
    text.trim().split('\n').find(|l| !l.is_empty()).unwrap_or("git command failed").to_owned()
}

/// JavaScript's `parseInt(s, 10)`: leading whitespace, a sign, then digits.
pub(crate) fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value: i64 = digits[..end].parse().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

pub(crate) fn count(s: &str) -> u32 {
    parse_int(s).and_then(|n| u32::try_from(n).ok()).unwrap_or(0)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) cap: usize,
    pub(crate) timeout: Option<Duration>,
}

impl Default for Limits {
    fn default() -> Self {
        Self { cap: DEFAULT_CAP, timeout: None }
    }
}

/// `git`'s arguments past a leading `-C <dir>`, and that folder.
fn subcommand(args: &[OsString]) -> (Option<&Path>, &[OsString]) {
    match args {
        [flag, dir, rest @ ..] if flag == "-C" => (Some(Path::new(dir)), rest),
        _ => (None, args),
    }
}

/// Whether a git command only reads. A read runs with `--no-optional-locks`
/// (it never takes `index.lock`, which would make an agent's own `git commit`
/// fail); anything not known to read counts as a write, after which what is
/// kept of its working tree is dropped.
pub(crate) fn is_read(args: &[OsString]) -> bool {
    let Some(words) = args.iter().map(|a| a.to_str()).collect::<Option<Vec<&str>>>() else { return false };
    let Some((first, rest)) = words.split_first() else { return false };
    match *first {
        "status" | "diff" | "rev-parse" | "rev-list" | "ls-files" | "log" | "show" | "merge-base" | "cat-file"
        | "for-each-ref" | "ls-tree" | "check-ignore" | "check-attr" | "describe" => true,
        "reflog" => rest.first().is_none_or(|w| w.starts_with('-') || *w == "show"),
        "stash" | "worktree" => matches!(rest.first(), Some(&("list" | "show"))),
        "remote" => rest.first().is_none_or(|w| matches!(*w, "get-url" | "-v" | "--verbose")),
        // Listing: flags only, none that changes a branch.
        "branch" => {
            const CHANGES: [&str; 14] = [
                "-d",
                "-D",
                "--delete",
                "-m",
                "-M",
                "--move",
                "-c",
                "-C",
                "--copy",
                "-f",
                "--force",
                "-u",
                "--unset-upstream",
                "--edit-description",
            ];
            rest.iter().all(|w| w.starts_with('-'))
                && !rest.iter().any(|w| CHANGES.contains(w) || w.starts_with("--set-upstream"))
        }
        _ => false,
    }
}

fn command_line(program: &str, args: &[OsString]) -> String {
    std::iter::once(program.to_owned())
        .chain(args.iter().map(|a| a.to_string_lossy().into_owned()))
        .collect::<Vec<_>>()
        .join(" ")
}

impl Git {
    /// Runs `program args…`, optionally in `cwd`, with extra environment.
    /// `git` starts by its resolved path; a read gets `--no-optional-locks`;
    /// a write tells the write hook its folder once it ended. A failure's
    /// message names the command as it was asked for.
    pub(crate) async fn exec(
        &self,
        program: &str,
        args: Vec<OsString>,
        cwd: Option<&Path>,
        env: &[(&str, &str)],
        limits: Limits,
    ) -> Result<Ran, Failed> {
        let line = command_line(program, &args);
        if program != "git" {
            return self.start(OsString::from(program), program, &line, args, cwd, env, limits).await;
        }
        let (dir, sub) = subcommand(&args);
        let (read, dir) = (is_read(sub), dir.or(cwd).map(Path::to_owned));
        let mut started = args.clone();
        if read {
            started.insert(0, "--no-optional-locks".into());
        }
        let path = self.program.get(&self.runner).await;
        let mut ran = self.start(path.clone(), program, &line, started.clone(), cwd, env, limits).await;
        // The binary moved (an Xcode update, say): look it up again, once.
        if matches!(&ran, Err(failed) if failed.stderr.is_none()) && self.program.forget(&path) {
            let path = self.program.get(&self.runner).await;
            ran = self.start(path, program, &line, started, cwd, env, limits).await;
        }
        if !read && let (Some(hook), Some(dir)) = (&self.on_write, dir) {
            hook(&dir);
        }
        ran
    }

    /// Starts `path`, reporting it as `program` with the command line `line`.
    #[allow(clippy::too_many_arguments)]
    async fn start(
        &self,
        path: OsString,
        program: &str,
        line: &str,
        args: Vec<OsString>,
        cwd: Option<&Path>,
        env: &[(&str, &str)],
        limits: Limits,
    ) -> Result<Ran, Failed> {
        let mut command = Command::new(path).args(args).max_output(limits.cap, Overflow::Fail);
        if let Some(cwd) = cwd {
            command = command.cwd(cwd);
        }
        if !env.is_empty() {
            let mut vars = Env::inherit();
            for (name, value) in env {
                vars = vars.set(*name, *value);
            }
            command = command.env(vars);
        }
        if let Some(timeout) = limits.timeout {
            command = command.timeout(timeout);
        }
        match self.runner.run(command).await {
            Ok(out) if out.success() => Ok(Ran { stderr: out.stderr_text(), stdout: out.stdout }),
            Ok(out) => {
                let stderr = out.stderr_text();
                let message = if stderr.is_empty() {
                    format!("Command failed: {line}")
                } else {
                    format!("Command failed: {line}\n{stderr}")
                };
                Err(Failed { code: out.exit_code, stdout: out.stdout_text(), stderr: Some(stderr), message })
            }
            Err(eos_kit_proc::Error::OutputTooLarge { .. }) => Err(Failed {
                code: None,
                stdout: String::new(),
                stderr: Some(String::new()),
                message: TOO_LARGE.to_owned(),
            }),
            Err(eos_kit_proc::Error::Spawn { source, .. }) => Err(Failed {
                code: None,
                stdout: String::new(),
                stderr: None,
                message: format!("could not start {program}: {source}"),
            }),
            Err(e) => Err(Failed { code: None, stdout: String::new(), stderr: None, message: e.to_string() }),
        }
    }

    fn git_args(cwd: &Path, args: &[&str]) -> Vec<OsString> {
        let mut all: Vec<OsString> = vec!["-C".into(), cwd.into()];
        all.extend(args.iter().map(OsString::from));
        all
    }

    /// `git -C <cwd> args…` with the ordinary limits.
    pub(crate) async fn run(&self, cwd: &Path, args: &[&str]) -> Result<Ran, Failed> {
        self.exec("git", Self::git_args(cwd, args), None, &[], Limits::default()).await
    }

    pub(crate) async fn run_with(
        &self,
        cwd: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        limits: Limits,
    ) -> Result<Ran, Failed> {
        self.exec("git", Self::git_args(cwd, args), None, env, limits).await
    }

    /// The command's stdout as text, or `None` when it failed.
    pub(crate) async fn text(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        self.run(cwd, args).await.ok().map(|ran| ran.text())
    }

    /// The command's stdout, trimmed; `None` when it failed or printed nothing.
    pub(crate) async fn line(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        self.text(cwd, args).await.map(|out| out.trim().to_owned()).filter(|out| !out.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_reads_a_leading_number_as_javascript_does() {
        assert_eq!(parse_int("42"), Some(42));
        assert_eq!(parse_int("  7 files"), Some(7));
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("x1"), None);
        assert_eq!(parse_int(""), None);
        assert_eq!(count("12\n"), 12);
        assert_eq!(count("-1"), 0);
        assert_eq!(count("nope"), 0);
    }

    fn args(line: &str) -> Vec<OsString> {
        line.split(' ').map(OsString::from).collect()
    }

    #[test]
    fn reads_are_told_from_writes() {
        for read in [
            "status --porcelain=v1 -z",
            "diff --numstat HEAD",
            "rev-parse --abbrev-ref HEAD",
            "branch --format=%(refname:short)",
            "branch -r --format=%(refname:short)",
            "branch --show-current",
            "stash list --format=%H",
            "remote",
            "remote get-url origin",
            "reflog -n 300 --format=%gs",
            "worktree list --porcelain",
            "ls-files --others --exclude-standard",
        ] {
            assert!(is_read(&args(read)), "{read}");
        }
        for write in [
            "checkout main",
            "branch feature",
            "branch -m a b",
            "branch -D x",
            "branch --set-upstream-to=origin/x",
            "stash push",
            "stash apply stash@{0}",
            "remote add o url",
            "reflog expire --all",
            "worktree add /x -b y",
            "commit -m x",
            "fetch --prune",
            "",
        ] {
            assert!(!is_read(&args(write)), "{write}");
        }
        let line = args("-C /r status");
        let (dir, rest) = subcommand(&line);
        assert_eq!((dir, rest.len()), (Some(Path::new("/r")), 1));
    }

    #[test]
    fn the_first_line_skips_blank_ones() {
        assert_eq!(first_line("\n\nfatal: nope\nhint: x\n"), "fatal: nope");
        assert_eq!(first_line("   "), "git command failed");
    }
}
