//! What the app may ask of the system it runs on.

use std::fmt::Debug;
use std::fs::Permissions;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::error::Error;

/// What Eos offers on this system; the dashboard hides what is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostFeatures {
    /// Pairing with other computers and phones.
    pub remote: bool,
    /// A POSIX shell for agents' commands exists ([`HostPlatform::script_shell`]).
    pub posix_shell: bool,
}

/// A program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Argv {
    pub file: String,
    pub args: Vec<String>,
}

/// How to start an executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnCommand {
    pub file: String,
    pub args: Vec<String>,
    /// Windows: pass the arguments unquoted (a `.cmd` shim run through `cmd`).
    pub verbatim_arguments: bool,
}

/// The secrets the system keeps for the user.
pub trait CredentialStore: Send + Sync + Debug {
    /// Raw JSON of a Claude Code login store; no `store_dir` = the user's own Claude Code login.
    fn read_claude_store(&self, store_dir: Option<&Path>) -> Option<String>;
    /// Replaces a store's login document, as the claude binary writes it: an
    /// item that exists is rewritten in place, whoever created it.
    fn write_claude_store(&self, store_dir: &Path, json: &str) -> Result<(), Error>;
    /// Removes a store's login, as `claude auth logout` does.
    fn clear_claude_store(&self, store_dir: &Path);
    /// A secret saved under `service` (a provider API key).
    fn read_secret(&self, service: &str) -> Option<String>;
    /// Saves a secret under `service`, replacing one already there.
    fn write_secret(&self, service: &str, secret: &str) -> Result<(), Error>;
    /// Removes the secret under `service`; one that is not there is not an error.
    fn delete_secret(&self, service: &str);
}

/// The Keychain item the claude binary keeps a store's login in: a store dir
/// (set through `CLAUDE_SECURESTORAGE_CONFIG_DIR`) gets its own item, suffixed
/// with a hash of that dir.
pub fn claude_store_service(store_dir: Option<&Path>) -> String {
    let Some(dir) = store_dir else { return "Claude Code-credentials".to_owned() };
    let normalized: String = dir.to_string_lossy().nfc().collect();
    let digest = Sha256::digest(normalized.as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("Claude Code-credentials-{hex}")
}

/// The shell terminals and `!` commands run in.
pub trait TerminalShell: Send + Sync + Debug {
    /// A terminal tab's shell; with `command` it runs that first, and stays open after unless `exit_after_command`.
    fn interactive(&self, command: Option<&str>, exit_after_command: bool) -> Argv;
    /// One command line, run without a terminal but with the user's shell profile.
    fn run(&self, command: &str) -> Argv;
    /// A command line that runs `b` only when `a` fails.
    fn or_else(&self, a: &str, b: &str) -> String;
    /// A process in a terminal can write to that terminal's device.
    fn tty_hooks(&self) -> bool;
}

/// Where "open in …" sends a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenTarget<'a> {
    /// Show the path selected in the file manager.
    FileManager,
    /// Open the path in an app. An app with a `scheme://file/<path>:<line>:<column>`
    /// URL (VS Code, Cursor) opens at the line.
    App { name: &'a str, line_url_scheme: Option<&'a str> },
}

/// The app that opens a kind of file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultApp {
    /// Where the app is installed.
    pub bundle_path: String,
    /// Its identifier (`com.apple.TextEdit`); empty when it declares none.
    pub bundle_id: String,
    /// The name the system shows for it.
    pub app_name: String,
}

/// Handing paths to other apps.
pub trait Desktop: Send + Sync + Debug {
    /// Opens the path with its default app.
    fn open_path(&self, path: &Path) -> Result<(), Error>;
    fn reveal_path(&self, path: &Path) -> Result<(), Error>;
    fn open_in(&self, target: OpenTarget<'_>, path: &Path, line: Option<u32>, column: Option<u32>)
    -> Result<(), Error>;
    /// An app of that name is installed for this user.
    fn app_installed(&self, app_name: &str) -> bool;
    /// The app the system opens `file` with; the file must exist. `None` when
    /// there is none, or the system cannot say.
    fn default_app(&self, file: &Path) -> Option<DefaultApp>;
    /// Writes the app's icon to `out` as a 64×64 PNG.
    fn render_app_icon(&self, bundle_path: &Path, out: &Path) -> Result<(), Error>;
    /// Writes the image at `image` (PNG, JPEG or WebP) to `out` as a `width`×`height` PNG.
    fn render_scaled_image(&self, image: &Path, width: u32, height: u32, out: &Path) -> Result<(), Error>;
}

/// How the installed app takes in a new release on this system.
pub trait AppUpdatePlatform: Send + Sync + Debug {
    /// The update feed's name for this system and CPU.
    fn feed_platform(&self) -> &'static str;
    /// The installed app the running executable belongs to, or `None` when it is not inside one.
    fn bundle_root(&self, exec_path: &Path) -> Option<PathBuf>;
    /// Where an app at `bundle_root` keeps the files it ships with (its `update.json`).
    fn resources_dir(&self, bundle_root: &Path) -> PathBuf;
    /// Files keep their permission bits here, so a staged copy's modes must match the release.
    fn file_modes(&self) -> bool;
    /// The staged copy is signed by the same developer as the installed app and
    /// the system would run it; [`Error::RejectedBundle`] when not.
    fn verify_bundle(&self, staged: &Path, installed: &Path) -> Result<(), Error>;
}

/// The app's screen saver.
pub trait ScreenSaver: Send + Sync + Debug {
    /// Installs the saver the app ships in `resources` for this user, replacing an older
    /// copy, and opens the settings where the user picks it.
    fn install(&self, resources: &Path) -> Result<(), Error>;
    /// Starts the screen saver now, on every display.
    fn start(&self) -> Result<(), Error>;
}

/// Holds the computer out of system sleep until dropped.
#[derive(Debug)]
pub struct KeepAwake {
    child: Child,
}

impl KeepAwake {
    pub(crate) fn new(child: Child) -> Self {
        Self { child }
    }

    /// The process holding the assertion.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub trait HostPlatform: Send + Sync + Debug {
    /// The system's name as Node reported it ("darwin") — shown to paired devices, never branched on.
    fn os(&self) -> &'static str;
    fn features(&self) -> HostFeatures;
    /// The name people gave this computer, or `None` to fall back to the hostname.
    fn friendly_computer_name(&self) -> Option<String>;
    /// A cap on open fds below `RLIMIT_NOFILE`, or `None` when the rlimit is the cap.
    fn fd_ceiling(&self) -> Option<u64>;
    /// A recursive watch costs no fd per file here.
    fn native_recursive_watch(&self) -> bool;
    fn credentials(&self) -> &dyn CredentialStore;
    /// Moves a path to the system trash; [`Error::Unsupported`] when there is none.
    fn trash(&self, path: &Path) -> Result<(), Error>;
    /// Keeps the computer out of system sleep while the process `pid` lives
    /// and the returned guard is held.
    fn keep_awake(&self, pid: u32) -> Result<KeepAwake, Error>;
    fn shell(&self) -> &dyn TerminalShell;
    /// The POSIX sh agents' command lines run in, or `None` when the system has none.
    fn script_shell(&self) -> Option<PathBuf>;
    /// The file names a CLI called `name` is installed under, in the order to look for them.
    fn executable_names(&self, name: &str) -> Vec<String>;
    /// What to spawn to run `file` with `args`.
    fn spawn_command(&self, file: &str, args: &[String]) -> SpawnCommand;
    /// Makes the command's child lead its own process tree, so
    /// [`kill_process_tree`](Self::kill_process_tree) ends everything it started.
    fn isolate_command(&self, command: &mut Command);
    /// Ends a process started with [`isolate_command`](Self::isolate_command)
    /// and everything it started; [`Error::NoSuchProcess`] when it is gone.
    fn kill_process_tree(&self, pid: u32) -> Result<(), Error>;
    /// A process with that id exists.
    fn process_alive(&self, pid: u32) -> bool;
    /// Where a Chromium browser is usually installed, most preferred first.
    fn chromium_browsers(&self) -> Vec<PathBuf>;
    /// The command that prints one location fix as JSON
    /// ([`read_location`](crate::read_location)), or `None` on a system
    /// without a helper. `resources` is where the app keeps what it ships
    /// beside its executable; `wait_seconds` is how long the helper waits.
    fn location_helper(&self, resources: &Path, wait_seconds: u32) -> Option<Argv>;
    /// In-app updates; `None` where Eos cannot update itself.
    fn app_updates(&self) -> Option<&dyn AppUpdatePlatform>;
    fn desktop(&self) -> &dyn Desktop;
    /// The app's screen saver; `None` where the system has none Eos can install.
    fn screen_saver(&self) -> Option<&dyn ScreenSaver>;
    /// Permissions for a file only the user may read (keys, tokens); `None`
    /// where the system has no such bits and the folder's protection applies.
    fn private_file_permissions(&self) -> Option<Permissions>;
}
