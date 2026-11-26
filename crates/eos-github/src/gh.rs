//! The real GitHub CLI. `gh` is looked for where its installers put it, then
//! in Eos's own tools folder; when it is nowhere, GitHub's own release
//! [`VERSION`] is downloaded there, and kept only when its SHA-256 is the one
//! written here. `gh` runs with the user's home and none of the token
//! variables, so it answers with the sign-in the user's terminal has. Its
//! sign-in is the one started by `gh auth login --web`: `gh` prints a code,
//! the user enters it on GitHub's page, and `gh` keeps the token itself.
//! Neither the code nor the token reaches a log.

use std::path::{Path, PathBuf};
use std::time::Duration;

use eos_core::BoxFuture;
use eos_kit_proc::{Child, Command, Env, Event, Runner};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::Error;
use crate::cli::{Cli, CliError, Login, read_prompt};
use crate::client::WEB;

/// The release Eos installs when the computer has no `gh`.
const VERSION: &str = "2.106.0";
/// The SHA-256 of that release's macOS archives, from its checksums file.
const SHA256_ARM64: &str = "22b2b723dfbc69b6022b1b08604ff51c0db5aa8b6774b4ced1a47b8413a995d6";
const SHA256_AMD64: &str = "f43a04a5ffe0717e2e39d7591cbc50db24c6c38d09d0ea4998be27cd197758e3";
/// Where Homebrew (Apple silicon, Intel) and MacPorts put `gh`.
const INSTALLED: [&str; 3] = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/local/bin/gh"];
const HOST: &str = "github.com";
/// What `gh` sees of Eos's environment: where the user's sign-in is kept.
const KEPT: [&str; 6] = ["HOME", "USER", "PATH", "LANG", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"];
/// How long `gh` may take to answer with a token.
const TOKEN_TIMEOUT: Duration = Duration::from_secs(20);
/// How long GitHub's sign-in code lives.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long `gh` may take to print the sign-in's code.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const UNPACK_TIMEOUT: Duration = Duration::from_secs(60);

pub struct Gh {
    runner: Runner,
    client: reqwest::Client,
    /// Eos's own tools folder, where an installed `gh` goes.
    tools: PathBuf,
}

impl std::fmt::Debug for Gh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gh").field("tools", &self.tools).finish_non_exhaustive()
    }
}

/// The archive of [`VERSION`] for this computer: its name without `.zip`,
/// and its SHA-256.
fn archive() -> Option<(String, &'static str)> {
    let (arch, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("arm64", SHA256_ARM64),
        ("macos", "x86_64") => ("amd64", SHA256_AMD64),
        _ => return None,
    };
    Some((format!("gh_{VERSION}_macOS_{arch}"), sha256))
}

fn environment() -> Env {
    Env::only(KEPT).set("GH_PROMPT_DISABLED", "1").set("GH_NO_UPDATE_NOTIFIER", "1").set("NO_COLOR", "1")
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> std::io::Result<T> + Send + 'static) -> std::io::Result<T> {
    tokio::task::spawn_blocking(job).await.map_err(std::io::Error::other)?
}

/// Waits for `gh`'s sign-in to end.
async fn ended(mut child: Child) -> Result<(), CliError> {
    while let Some(event) = child.next().await {
        if let Event::Exit(exit) = event {
            return match exit.code {
                Some(0) => Ok(()),
                _ if exit.timed_out => Err(CliError::Expired),
                _ => Err(CliError::Failed),
            };
        }
    }
    Err(CliError::Failed)
}

impl Gh {
    pub fn new(runner: Runner, tools: PathBuf) -> Result<Self, Error> {
        let options = eos_kit_net::ClientOptions {
            timeout: Some(DOWNLOAD_TIMEOUT),
            ..eos_kit_net::ClientOptions::new(concat!("Eos/", env!("CARGO_PKG_VERSION")))
        };
        let client = eos_kit_net::http_client(&options).map_err(|e| Error::Transport(e.to_string()))?;
        Ok(Self { runner, client, tools })
    }

    /// Where the `gh` Eos installs lives.
    fn own(&self) -> PathBuf {
        self.tools.join("gh").join(VERSION).join("bin").join("gh")
    }

    async fn find(&self) -> Option<PathBuf> {
        let candidates: Vec<PathBuf> = INSTALLED.iter().map(PathBuf::from).chain([self.own()]).collect();
        blocking(move || Ok(candidates.into_iter().find(|path| path.is_file()))).await.ok().flatten()
    }

    async fn program(&self) -> Result<PathBuf, CliError> {
        self.find().await.ok_or(CliError::Missing)
    }

    /// Downloads GitHub's release, checks it and unpacks it into the tools
    /// folder.
    async fn install(&self) -> Result<(), CliError> {
        let Some((name, sha256)) = archive() else { return Err(CliError::Missing) };
        let url = format!("{WEB}/cli/cli/releases/download/v{VERSION}/{name}.zip");
        let downloaded = async { self.client.get(&url).send().await?.error_for_status()?.bytes().await };
        let bytes = downloaded.await.map_err(|e| {
            tracing::warn!(host = HOST, error = %e.without_url(), "the GitHub CLI could not be downloaded");
            CliError::Missing
        })?;
        let found: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
        if found != sha256 {
            tracing::warn!(version = VERSION, "the downloaded GitHub CLI is not the release expected: it was dropped");
            return Err(CliError::Missing);
        }
        let home = self.tools.join("gh");
        let (zip, unpacked) = (home.join(format!("{name}.zip")), home.join(format!("{VERSION}.unpacking")));
        let prepared = {
            let (home, zip, unpacked) = (home.clone(), zip.clone(), unpacked.clone());
            blocking(move || {
                std::fs::create_dir_all(&home)?;
                if unpacked.exists() {
                    std::fs::remove_dir_all(&unpacked)?;
                }
                std::fs::write(&zip, &bytes)
            })
        };
        let failed = |e: &dyn std::fmt::Display| {
            tracing::warn!(error = %e, "the GitHub CLI could not be installed");
            CliError::Missing
        };
        prepared.await.map_err(|e| failed(&e))?;
        let unpack = Command::new("/usr/bin/ditto")
            .args([Path::new("-x").as_os_str(), Path::new("-k").as_os_str(), zip.as_os_str(), unpacked.as_os_str()])
            .env(Env::empty())
            .timeout(UNPACK_TIMEOUT);
        let output = self.runner.run(unpack).await.map_err(|e| failed(&e))?;
        if !output.success() {
            return Err(failed(&"the archive did not unpack"));
        }
        let placed = {
            let (from, to) = (unpacked.join(&name), home.join(VERSION));
            blocking(move || {
                if !to.exists() {
                    std::fs::rename(from, to)?;
                }
                std::fs::remove_dir_all(unpacked)?;
                std::fs::remove_file(zip)
            })
        };
        placed.await.map_err(|e| failed(&e))?;
        tracing::info!(version = VERSION, "the GitHub CLI was installed");
        Ok(())
    }

    async fn ensured(&self) -> Result<(), CliError> {
        if self.find().await.is_some() {
            return Ok(());
        }
        self.install().await?;
        self.program().await.map(drop)
    }

    async fn read_token(&self, account: Option<&str>) -> Result<Zeroizing<String>, CliError> {
        let mut command = Command::new(self.program().await?).args(["auth", "token", "--hostname", HOST]);
        if let Some(account) = account {
            command = command.args(["--user", account]);
        }
        let output = self.runner.run(command.env(environment()).timeout(TOKEN_TIMEOUT)).await;
        let output = output.map_err(|_| CliError::Failed)?;
        if output.timed_out {
            return Err(CliError::Failed);
        }
        let token = Zeroizing::new(output.stdout_text().trim().to_owned());
        if output.success() && !token.is_empty() { Ok(token) } else { Err(CliError::SignedOut) }
    }

    async fn start_login(&self) -> Result<Login, CliError> {
        // Eos opens the page itself, where the user sees the code beside it.
        let env = environment().set("GH_BROWSER", "/usr/bin/true");
        let command = Command::new(self.program().await?)
            .args(["auth", "login", "--hostname", HOST, "--web"])
            .env(env)
            .timeout(LOGIN_TIMEOUT);
        let mut child = self.runner.spawn(command).await.map_err(|_| CliError::Failed)?;
        let prompt = async {
            let mut printed = Zeroizing::new(String::new());
            while let Some(event) = child.next().await {
                match event {
                    Event::Stdout(bytes) | Event::Stderr(bytes) => printed.push_str(&String::from_utf8_lossy(&bytes)),
                    Event::Exit(_) => return None,
                }
                if let Some(read) = read_prompt(&printed) {
                    return Some(read);
                }
            }
            None
        };
        let read = tokio::time::timeout(PROMPT_TIMEOUT, prompt).await.ok().flatten();
        let Some((user_code, verification_uri)) = read else {
            tracing::info!(host = HOST, "the GitHub CLI gave no sign-in code");
            return Err(CliError::Failed);
        };
        Ok(Login { user_code: Zeroizing::new(user_code), verification_uri, done: Box::pin(ended(child)) })
    }
}

impl Cli for Gh {
    fn ensure(&self) -> BoxFuture<'_, Result<(), CliError>> {
        Box::pin(self.ensured())
    }

    fn token<'a>(&'a self, account: Option<&'a str>) -> BoxFuture<'a, Result<Zeroizing<String>, CliError>> {
        Box::pin(self.read_token(account))
    }

    fn login(&self) -> BoxFuture<'_, Result<Login, CliError>> {
        Box::pin(self.start_login())
    }
}
