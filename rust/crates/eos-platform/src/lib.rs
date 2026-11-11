//! The one place operating-system differences live.
//!
//! [`host()`] is chosen once at build time; callers read what the system can
//! do from it and never test for a system themselves. `cfg(target_os)` appears
//! only in this crate (and in the window shell's own seam).
//!
//! Everything here is synchronous and may block on a system tool for up to
//! its timeout: call it from a blocking thread, not from an async task.
//!
//! macOS is implemented. Any other system gets [`generic`]: no trash, no
//! keep-awake, no secret store, no desktop integration. A Windows
//! implementation is one more module behind the same traits.

mod backup;
mod copy;
mod error;
mod host;
mod paths;
mod process;
mod shell;
mod tool;

#[cfg(target_os = "macos")]
mod darwin;
mod generic;

pub use backup::StartupBackup;
pub use copy::{clone_copy, clone_copy_tree};
pub use error::Error;
pub use host::{
    AppUpdatePlatform, Argv, CredentialStore, Desktop, HostFeatures, HostPlatform, KeepAwake, OpenTarget, SpawnCommand,
    TerminalShell, claude_store_service,
};
pub use paths::{DataPaths, USER_DATA_ENTRIES, eos_home, expand_path, home_dir};
pub use process::{isolate_command, kill_process_tree, process_alive};
pub use shell::{PosixShell, shell_invocation};

#[cfg(target_os = "macos")]
pub use darwin::{SecurityKeychain, caffeinate_args, open_in_argv, trash_argv};

/// The system this build runs on.
pub fn host() -> &'static dyn HostPlatform {
    #[cfg(target_os = "macos")]
    {
        &darwin::DARWIN
    }
    #[cfg(not(target_os = "macos"))]
    {
        &generic::GENERIC
    }
}

/// A system without an adapter of its own.
pub fn generic_host() -> &'static dyn HostPlatform {
    &generic::GENERIC
}
