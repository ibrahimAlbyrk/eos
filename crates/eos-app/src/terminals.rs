//! Terminals on this computer: the PTY, the user's shell and their Claude Code.

use std::path::PathBuf;
use std::sync::Arc;

use eos_core::BoxFuture;
use eos_core::accounts::{SessionCredential, SessionCredentials};
use eos_core::terminal::ClaudeLaunchEnv;
use eos_kit_proc::{ProcessTrees, Runner};
use eos_pty::{ClaudeLocator, ClaudeTranscriptFiles, PtyTerminals, ShellRunner};

use crate::modules::Terminal;

/// Where Claude Code keeps its login (it reads the user's own without this).
const CLAUDE_STORE_ENV: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
const CLAUDE_TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";
const PROVIDER: &str = "anthropic";

/// A Code-view Claude runs on the sign-in a new agent session would use: its
/// store when there is one, else Eos's first store (never the user's own
/// Claude Code login). A setup-token from before sign-ins had stores is handed
/// over while no store holds a sign-in. An API key is not: the pane then asks
/// the user to sign in, inside Eos's store.
struct ClaudePaneEnv {
    credentials: Arc<dyn SessionCredentials>,
    default_store: PathBuf,
}

/// The app's environment with `set` on top.
fn environment_with(set: Vec<(&str, String)>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .filter(|(name, _)| !set.iter().any(|(ours, _)| ours == name))
        .collect();
    env.extend(set.into_iter().map(|(name, value)| (name.to_owned(), value)));
    env
}

fn pane_env(credential: Option<SessionCredential>, default_store: &std::path::Path) -> Vec<(String, String)> {
    let store = |dir: &std::path::Path| (CLAUDE_STORE_ENV, dir.to_string_lossy().into_owned());
    environment_with(match credential {
        Some(SessionCredential::Store { dir, .. }) => vec![store(&dir)],
        Some(SessionCredential::Bearer { token, .. }) => vec![store(default_store), (CLAUDE_TOKEN_ENV, token)],
        Some(SessionCredential::ApiKey { .. }) | None => vec![store(default_store)],
    })
}

impl ClaudeLaunchEnv for ClaudePaneEnv {
    fn env(&self) -> BoxFuture<'_, Option<Vec<(String, String)>>> {
        Box::pin(async move { Some(pane_env(self.credentials.for_new_session(PROVIDER).await, &self.default_store)) })
    }
}

/// `default_store`: the folder of Eos's first Claude sign-in (`accounts/claude`).
pub(crate) fn terminal(credentials: Arc<dyn SessionCredentials>, default_store: PathBuf) -> Terminal {
    let platform = eos_platform::host();
    let shell = platform.shell();
    let runner = Runner::new(ProcessTrees::new(eos_platform::isolate_command, |pid| {
        eos_platform::kill_process_tree(pid).is_ok()
    }));
    let home = eos_platform::home_dir();
    Terminal {
        ptys: Arc::new(PtyTerminals::new(shell)),
        commands: Arc::new(ShellRunner::new(runner.clone(), shell, platform.script_shell())),
        claude: Arc::new(ClaudeLocator::new(runner, shell, home.clone())),
        claude_env: Arc::new(ClaudePaneEnv { credentials, default_store }),
        transcripts: Arc::new(ClaudeTranscriptFiles::new(home.clone().unwrap_or_default())),
        default_cwd: home.map_or_else(|| "/".to_owned(), |h| h.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn value<'a>(env: &'a [(String, String)], name: &str) -> Vec<&'a str> {
        env.iter().filter(|(n, _)| n == name).map(|(_, v)| v.as_str()).collect()
    }

    #[test]
    fn a_claude_pane_reads_eos_sign_in_and_never_the_users_own() {
        let default = Path::new("/eos/accounts/claude");
        let store =
            SessionCredential::Store { provider: PROVIDER.into(), dir: PathBuf::from("/eos/accounts/claude-lg-1") };
        let env = pane_env(Some(store), default);
        assert_eq!(value(&env, CLAUDE_STORE_ENV), ["/eos/accounts/claude-lg-1"]);
        // The rest of the app's environment comes along.
        assert_eq!(env.len(), std::env::vars_os().filter(|(k, _)| k != CLAUDE_STORE_ENV).count() + 1);

        // An old setup-token is handed over; the store is still Eos's.
        let bearer = SessionCredential::Bearer { provider: PROVIDER.into(), token: "tok".into() };
        let env = pane_env(Some(bearer), default);
        assert_eq!(value(&env, CLAUDE_STORE_ENV), ["/eos/accounts/claude"]);
        assert_eq!(value(&env, CLAUDE_TOKEN_ENV), ["tok"]);

        // An API key is not given to a pane, and no sign-in is no reason to read the user's.
        let key = SessionCredential::ApiKey { provider: PROVIDER.into(), key: "sk".into() };
        for credential in [Some(key), None] {
            let env = pane_env(credential, default);
            assert_eq!(value(&env, CLAUDE_STORE_ENV), ["/eos/accounts/claude"]);
            assert!(!env.iter().any(|(_, v)| v == "sk"));
        }
    }
}
