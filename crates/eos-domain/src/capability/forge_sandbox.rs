//! The engine's sandbox for every shell command of a Forge run's team, as
//! the project settings of its build folder hold it (06 G9; L9): on,
//! failing when the OS sandbox is missing, never bypassed by a command,
//! writes held to the folder, the home folder unreadable but for the build
//! folder and `TOOLCHAIN_READS`, the network to `REGISTRY_HOSTS`, no Apple
//! Events. The builder's own file edits never reach these settings (its
//! scope).

use std::path::Path;

use serde_json::json;

/// The hosts the builder's shell reaches without asking: package registries.
/// Any other host the engine's sandbox asks Eos's gate about.
pub const REGISTRY_HOSTS: [&str; 6] =
    ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io"];

/// What the builder's shell may still read in the user's home folder (L9):
/// the toolchains it builds with, never their sign-ins (`~/.cargo`'s
/// credentials, `~/.npmrc`).
pub const TOOLCHAIN_READS: [&str; 10] = [
    "~/.cargo/bin",
    "~/.cargo/registry",
    "~/.cargo/git",
    "~/.rustup",
    "~/.npm",
    "~/.nvm",
    "~/.volta",
    "~/.pyenv",
    "~/.bun",
    "~/.deno",
];

/// The `.claude/settings.json` of the build folder `folder`.
pub fn settings(folder: &Path) -> String {
    let reads = std::iter::once(folder.to_string_lossy().into_owned()).chain(TOOLCHAIN_READS.map(str::to_owned));
    let settings = json!({"sandbox": {
        "enabled": true,
        "failIfUnavailable": true,
        "allowUnsandboxedCommands": false,
        "autoAllowBashIfSandboxed": false,
        "allowAppleEvents": false,
        "filesystem": {"denyRead": ["~"], "allowRead": reads.collect::<Vec<_>>()},
        "network": {"allowedDomains": REGISTRY_HOSTS},
    }});
    format!("{settings:#}\n")
}
