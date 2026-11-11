//! The user's login shell, as `infra/src/platform/posix-shell.ts` drives it.

use std::path::Path;

use crate::host::{Argv, TerminalShell};

const FALLBACK_SHELL: &str = "/bin/bash";

/// Flags that make a shell read the user's profile for one command. zsh reads
/// `.zshrc` only when interactive, so it needs `-i`; `bash -i` without a
/// terminal prints "no job control" on every run, so bash stays login-only;
/// fish always reads its config.
fn flags(shell: &str) -> &'static [&'static str] {
    match Path::new(shell).file_name().and_then(|n| n.to_str()) {
        Some("zsh") => &["-i", "-l", "-c"],
        _ => &["-l", "-c"],
    }
}

/// `shell` running `command` with the user's profile loaded.
pub fn shell_invocation(shell: &str, command: &str) -> Argv {
    let mut args: Vec<String> = flags(shell).iter().map(|f| (*f).to_owned()).collect();
    args.push(command.to_owned());
    Argv { file: shell.to_owned(), args }
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A POSIX login shell; `None` reads `$SHELL` at each call.
#[derive(Debug, Clone, Default)]
pub struct PosixShell {
    shell: Option<String>,
}

impl PosixShell {
    pub const fn from_env() -> Self {
        Self { shell: None }
    }

    pub fn fixed(shell: impl Into<String>) -> Self {
        Self { shell: Some(shell.into()) }
    }

    fn path(&self) -> String {
        self.shell
            .clone()
            .or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| FALLBACK_SHELL.to_owned())
    }
}

impl TerminalShell for PosixShell {
    // A terminal tab is an interactive login shell; with a command, that shell
    // runs it, then execs a plain login shell so the tab outlives the command.
    fn interactive(&self, command: Option<&str>, exit_after_command: bool) -> Argv {
        let shell = self.path();
        let args = match command.filter(|c| !c.is_empty()) {
            None => vec!["-l".to_owned()],
            Some(command) => {
                let line = if exit_after_command {
                    command.to_owned()
                } else {
                    format!("{command}; exec {} -l", quote(&shell))
                };
                vec!["-l".to_owned(), "-i".to_owned(), "-c".to_owned(), line]
            }
        };
        Argv { file: shell, args }
    }

    // The user's own shell, not bash: a foreign shell sourcing the user's
    // profile sprays "bad substitution" noise into every command.
    fn run(&self, command: &str) -> Argv {
        shell_invocation(&self.path(), command)
    }

    fn or_else(&self, a: &str, b: &str) -> String {
        format!("{a} || {b}")
    }

    fn tty_hooks(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(file: &str, args: &[&str]) -> Argv {
        Argv { file: file.to_owned(), args: args.iter().map(|a| (*a).to_owned()).collect() }
    }

    #[test]
    fn each_shell_gets_the_flags_that_load_its_profile() {
        assert_eq!(shell_invocation("/bin/zsh", "echo hi"), argv("/bin/zsh", &["-i", "-l", "-c", "echo hi"]));
        assert_eq!(shell_invocation("/bin/bash", "echo hi"), argv("/bin/bash", &["-l", "-c", "echo hi"]));
        assert_eq!(
            shell_invocation("/opt/homebrew/bin/fish", "ls"),
            argv("/opt/homebrew/bin/fish", &["-l", "-c", "ls"])
        );
        assert_eq!(shell_invocation("/opt/weird/shell", "ls"), argv("/opt/weird/shell", &["-l", "-c", "ls"]));
    }

    #[test]
    fn a_tab_is_a_login_shell_that_runs_a_command_first_and_stays_open() {
        let shell = PosixShell::fixed("/bin/zsh");
        assert_eq!(shell.interactive(None, false), argv("/bin/zsh", &["-l"]));
        assert_eq!(
            shell.interactive(Some("top"), false),
            argv("/bin/zsh", &["-l", "-i", "-c", "top; exec '/bin/zsh' -l"])
        );
        assert_eq!(shell.interactive(Some("top"), true), argv("/bin/zsh", &["-l", "-i", "-c", "top"]));
        assert_eq!(shell.run("ls"), argv("/bin/zsh", &["-i", "-l", "-c", "ls"]));
    }

    #[test]
    fn a_shell_path_with_a_quote_stays_one_word() {
        let shell = PosixShell::fixed("/opt/it's/sh");
        assert_eq!(shell.interactive(Some("x"), false).args[3], "x; exec '/opt/it'\\''s/sh' -l");
    }

    #[test]
    fn falls_back_with_or() {
        assert_eq!(PosixShell::from_env().or_else("a", "b"), "a || b");
    }
}
