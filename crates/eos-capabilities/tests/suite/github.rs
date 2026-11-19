//! The service over the real `github` built-in, which talks to `FakeGitHub`.

use std::sync::Arc;

use eos_capabilities::CapabilityService;
use eos_contracts::{ItemRef, Part, ResultDoc};
use eos_github::{GitHub, Parts};
use eos_testkit::{FakeCapabilitySecrets, FakeGitHub, FakeSleeper, GITHUB_TOKEN};
use serde_json::{Map, json};

use crate::rig::{Rig, Setup, rig};

pub(crate) const REPO: &str = "acme/game";
pub(crate) const HEAD: &str = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
/// One hunk over lines 27 to 32.
pub(crate) const PATCH: &str = "@@ -27,6 +27,6 @@ fn main()\n a\n b\n c\n-old\n+new\n d\n e";

pub(crate) struct GitHubRig {
    pub(crate) rig: Rig,
    pub(crate) fake: Arc<FakeGitHub>,
}

impl GitHubRig {
    pub(crate) fn service(&self) -> &Arc<CapabilityService> {
        &self.rig.service
    }
}

/// Signed in, with pull request 7 by `alice` at [`HEAD`].
pub(crate) async fn github() -> GitHubRig {
    let fake = Arc::new(FakeGitHub::new());
    fake.add_pull(REPO, 7, "alice", HEAD, 1_763_400_000_000, &[("src/main.rs", PATCH)]);
    let secrets = FakeCapabilitySecrets::new().with("github", "token", GITHUB_TOKEN);
    let builtin = Arc::new(GitHub::new(Parts {
        transport: fake.clone(),
        secrets: Arc::new(FakeCapabilitySecrets::new()),
        clock: Arc::new(eos_testkit::FakeClock::at(1_763_460_000_000)),
        sleeper: Arc::new(FakeSleeper::default()),
        client_id: "Iv1.fake".into(),
    }));
    let rig = rig(Setup { builtins: vec![builtin], secrets, ..Setup::default() }).await;
    GitHubRig { rig, fake }
}

/// Pull request `number` of [`REPO`] as a run takes it, at `sha`.
pub(crate) fn pull_item(number: u64, sha: &str) -> ItemRef {
    ItemRef {
        kind: "github.pull_request".into(),
        key: Some(format!("github:pr:{REPO}#{number}@{sha}")),
        title: None,
        url: Some(format!("https://github.com/{REPO}/pull/{number}")),
        path: None,
        text: None,
        date: None,
        range: None,
        version: Some(sha.into()),
        untrusted: true,
    }
}

fn part(key: &str, role: &str, text: &str, meta: Map<String, serde_json::Value>) -> Part {
    Part { key: key.into(), role: role.into(), text: text.into(), meta }
}

/// A review with one line comment on line `line` of `src/main.rs`.
pub(crate) fn review(action: &str, event: &str, line: u64) -> ResultDoc {
    let meta = json!({ "path": "src/main.rs", "line": line, "side": "RIGHT" });
    let meta = meta.as_object().cloned().unwrap_or_default();
    ResultDoc {
        kind: "github.review".into(),
        channel: "github".into(),
        action: action.into(),
        parts: vec![
            part("event", "event", event, Map::new()),
            part("summary", "summary", "Two notes.", Map::new()),
            part("c:1", "comment", "Why the change?", meta),
        ],
    }
}
