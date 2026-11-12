//! Who a local request comes from, told by the ui-token.
//!
//! The token proves a request was made by this computer's dashboard: a
//! sandboxed frame or a plugin's page can reach the app's origin too, but
//! cannot read the token. It is kept in `<home>/ui-token` across restarts, as
//! today, so an open window keeps working; deleting the file rotates it.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use eos_core::Ids;
use eos_domain::peer::{ViewTokens, is_fingerprint};
use eos_kit_fs::{WriteOptions, atomic_write};
use eos_runtime::access::{Caller, LocalCaller};
use eos_runtime::http::{normalize_path, split_target};

const TOKEN_FILE: &str = "ui-token";

#[derive(Clone)]
pub struct Callers {
    ui_token: String,
    view_tokens: Arc<ViewTokens>,
}

impl std::fmt::Debug for Callers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Callers").finish_non_exhaustive()
    }
}

/// What today's code accepts as a stored token: 32 or more lower-case hex characters.
fn well_formed(token: &str) -> bool {
    token.len() >= 32 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Callers {
    /// Reads the folder's token, or mints one and saves it (readable by the
    /// user only). A token that cannot be saved still works until the app ends.
    pub(crate) fn load(home: &Path, ids: &dyn Ids) -> Self {
        let path = home.join(TOKEN_FILE);
        if let Ok(stored) = fs::read_to_string(&path)
            && well_formed(stored.trim())
        {
            return Self::with(stored.trim().to_owned());
        }
        let ui_token = ids.ui_token();
        let options = WriteOptions::with_permissions(eos_platform::host().private_file_permissions());
        if let Err(e) = atomic_write(&path, ui_token.as_bytes(), &options) {
            tracing::warn!(error = %e, "the ui-token could not be saved");
        }
        Self::with(ui_token)
    }

    fn with(ui_token: String) -> Self {
        Self { view_tokens: Arc::new(ViewTokens::new(ui_token.clone())), ui_token }
    }

    /// The tokens of the views that control other computers: each is derived
    /// from the ui-token and counts only for its own host.
    pub fn view_tokens(&self) -> Arc<ViewTokens> {
        self.view_tokens.clone()
    }

    /// The token the shell gives the dashboard's own document.
    pub fn ui_token(&self) -> &str {
        &self.ui_token
    }

    /// The caller of a request made inside this computer's window, from the
    /// `x-eos-ui-token` header it carried (if any).
    pub fn classify(&self, token: Option<&str>) -> Caller {
        match token {
            Some(given) if same(&self.ui_token, given) => Caller::DASHBOARD,
            _ => Caller::UNTRUSTED,
        }
    }

    /// [`classify`](Self::classify) for a request whose path is known: a view
    /// that controls the paired computer `<id>` holds that host's view token
    /// and is that host's user under `/h/<id>/…` — and nobody anywhere else.
    pub fn classify_for(&self, token: Option<&str>, target: &str) -> Caller {
        let caller = self.classify(token);
        let (Caller::Local(LocalCaller::Untrusted), Some(token)) = (&caller, token) else { return caller };
        let path = normalize_path(split_target(target).0);
        let host = path.strip_prefix("/h/").and_then(|rest| rest.split('/').next()).filter(|id| is_fingerprint(id));
        match host {
            Some(host) if self.view_tokens.valid_for(token, host) => {
                Caller::Local(LocalCaller::HostView { host: host.into() })
            }
            _ => caller,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::{SeqIds, TempHome};

    #[test]
    fn the_token_is_minted_once_and_kept() {
        let home = TempHome::new();
        let first = Callers::load(home.path(), &SeqIds::new());
        assert_eq!(first.ui_token().len(), 48);
        assert_eq!(home.read("ui-token"), first.ui_token());
        let again = Callers::load(home.path(), &SeqIds::new());
        assert_eq!(again.ui_token(), first.ui_token(), "an open window keeps working after a restart");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(home.join("ui-token")).expect("the file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_malformed_token_file_is_replaced() {
        let home = TempHome::new();
        home.write("ui-token", "not-a-token\n");
        let callers = Callers::load(home.path(), &SeqIds::new());
        assert!(well_formed(callers.ui_token()));
        assert_eq!(home.read("ui-token"), callers.ui_token());
    }

    #[test]
    fn a_view_token_makes_its_hosts_view_under_that_hosts_prefix_only() {
        let home = TempHome::new();
        let callers = Callers::load(home.path(), &SeqIds::new());
        let (mine, other) = ("a".repeat(64), "b".repeat(64));
        let token = callers.view_tokens().mint(&mine);
        let view = Caller::Local(LocalCaller::HostView { host: mine.as_str().into() });
        assert_eq!(callers.classify_for(Some(&token), &format!("/h/{mine}/workers?limit=3")), view);
        assert_eq!(callers.classify_for(Some(&token), &format!("/h/{mine}")), view);
        assert_eq!(callers.classify_for(Some(&token), &format!("/h/{other}/workers")), Caller::UNTRUSTED);
        assert_eq!(callers.classify_for(Some(&token), "/workers"), Caller::UNTRUSTED, "never this computer's user");
        assert_eq!(
            callers.classify_for(Some(&token), &format!("/ui/../h/{mine}/x")),
            view,
            "judged on the resolved path"
        );
        assert_eq!(callers.classify_for(Some(callers.ui_token()), "/workers"), Caller::DASHBOARD);
        assert_eq!(callers.classify_for(None, &format!("/h/{mine}/workers")), Caller::UNTRUSTED);
        // Forgotten: its token stops counting.
        callers.view_tokens().revoke_host(&mine);
        assert_eq!(callers.classify_for(Some(&token), &format!("/h/{mine}/workers")), Caller::UNTRUSTED);
    }

    #[test]
    fn only_the_token_makes_a_dashboard() {
        let home = TempHome::new();
        let callers = Callers::load(home.path(), &SeqIds::new());
        let token = callers.ui_token().to_owned();
        assert_eq!(callers.classify(Some(&token)), Caller::DASHBOARD);
        assert_eq!(callers.classify(None), Caller::UNTRUSTED);
        assert_eq!(callers.classify(Some("")), Caller::UNTRUSTED);
        assert_eq!(callers.classify(Some(&token[..47])), Caller::UNTRUSTED);
        assert_eq!(callers.classify(Some(&format!("{}f", &token[..47]))), Caller::UNTRUSTED);
    }
}
