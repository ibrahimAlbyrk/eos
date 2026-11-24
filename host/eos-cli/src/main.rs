//! `eos`: the terminal's door to Eos. See the library for what it does.

use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::process::{Command, ExitCode};

use eos_cli::{Launcher, Place, START_WITHIN, Terminal, run};

struct System {
    stdin: std::io::Stdin,
}

impl Terminal for System {
    fn piped(&mut self) -> Option<&mut dyn Read> {
        if self.stdin.is_terminal() { None } else { Some(&mut self.stdin) }
    }

    fn interactive(&self) -> bool {
        self.stdin.is_terminal() && std::io::stderr().is_terminal()
    }

    fn out(&mut self, line: &str) {
        let _ = writeln!(std::io::stdout(), "{line}");
    }

    fn err(&mut self, line: &str) {
        let _ = writeln!(std::io::stderr(), "{line}");
    }

    fn confirm(&mut self, question: &str) -> bool {
        let _ = write!(std::io::stderr(), "{question} [y/N] ");
        let _ = std::io::stderr().flush();
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer).is_ok() && matches!(answer.trim(), "y" | "Y" | "yes")
    }
}

/// The app this command ships in: `<Eos.app>/Contents/Helpers/eos`, through any link to it.
fn own_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    let shipped = exe.parent()?.ends_with("Contents/Helpers") && bundle.extension().is_some_and(|e| e == "app");
    shipped.then(|| bundle.to_path_buf())
}

struct OpenHidden;

impl Launcher for OpenHidden {
    fn launch(&self) -> bool {
        let Some(bundle) = own_bundle() else { return false };
        // -g: not brought forward; -j: launched hidden; --background: no window (07 §4.1).
        Command::new("/usr/bin/open")
            .args(["-g", "-j", "-a"])
            .arg(&bundle)
            .args(["--args", "--background"])
            .status()
            .is_ok_and(|s| s.success())
    }
}

/// The shell's data folder: `EOS_SHELL_DATA` when set (a test or dev run), else the app's own.
fn shell_data() -> PathBuf {
    match std::env::var_os("EOS_SHELL_DATA").filter(|v| !v.is_empty()) {
        Some(named) => PathBuf::from(named),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support/com.ibrahimalbyrk.eos"),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let place = Place { shell_data: shell_data(), start_within: START_WITHIN };
    let code = run(&args, &cwd, &place, &mut System { stdin: std::io::stdin() }, &OpenHidden);
    ExitCode::from(u8::try_from(code).unwrap_or(2))
}
