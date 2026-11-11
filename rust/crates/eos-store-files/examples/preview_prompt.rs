//! Prints the system prompt an orchestrator or a worker session would get,
//! without starting anything (`scripts/preview-prompt.sh`).
//!
//! ```text
//! cargo run -p eos-store-files --example preview_prompt -- <orchestrator|worker>
//!     [--subagent] [--worktree] [--definition <name>] [--prompts <override folder>]
//! ```
//!
//! The provider is Claude. A worker is previewed as a subagent: all of a
//! worker's role fragments ask for one.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use eos_contracts::SessionFactsRole;
use eos_domain::ProviderIdentity;
use eos_prompts::preview::{PreviewOptions, render_preview};
use eos_prompts::tool_names::tool_name_vars;
use eos_prompts::{PromptRegistry, PromptService};
use eos_store_files::prompts::LibraryPromptSource;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (mut role, mut subagent, mut worktree) = (None, false, false);
    let (mut definition, mut overrides) = (String::new(), Vec::new());
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "orchestrator" => role = Some(SessionFactsRole::Orchestrator),
            "worker" => role = Some(SessionFactsRole::Worker),
            "--subagent" => subagent = true,
            "--worktree" => worktree = true,
            "--definition" => definition = args.next().unwrap_or_default(),
            "--prompts" => overrides.extend(args.next().map(PathBuf::from)),
            other => {
                eprintln!("preview_prompt: unknown argument \"{other}\"");
                return ExitCode::FAILURE;
            }
        }
    }
    let Some(role) = role else {
        eprintln!("preview_prompt: role must be \"orchestrator\" or \"worker\"");
        return ExitCode::FAILURE;
    };
    let registry = Arc::new(PromptRegistry::new(Arc::new(LibraryPromptSource::with_overrides(overrides))));
    let prompts = PromptService::new(registry, tool_name_vars());
    let options = PreviewOptions {
        role,
        identity: ProviderIdentity::claude(),
        subagent: subagent || role == SessionFactsRole::Worker,
        worktree,
        definition,
        cwd: std::env::current_dir().map(|dir| dir.display().to_string()).unwrap_or_default(),
    };
    print!("{}", render_preview(&prompts, &options).text);
    ExitCode::SUCCESS
}
