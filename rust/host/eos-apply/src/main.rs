//! `eos-apply <apply.json>` — see the library's documentation.

use std::path::Path;
use std::process::ExitCode;

use eos_apply::{MacSystem, Pending, run};

fn main() -> ExitCode {
    let Some(path) = std::env::args_os().nth(1) else {
        eprintln!("usage: eos-apply <apply.json>");
        return ExitCode::from(2);
    };
    match Pending::read(Path::new(&path)) {
        Ok(pending) => {
            run(&pending, &MacSystem);
            ExitCode::SUCCESS
        }
        // Nothing was touched: the installed app stays as it is.
        Err(e) => {
            eprintln!("eos-apply: {e}");
            ExitCode::FAILURE
        }
    }
}
