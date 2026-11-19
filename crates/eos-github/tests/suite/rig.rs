//! The capability on `FakeGitHub`, a fake clock and waits the test ends.

use std::collections::HashMap;
use std::sync::Arc;

use eos_core::capability::{ActionContext, ActionError, BuiltinCapability};
use eos_domain::capability::schema::compile;
use eos_github::{GitHub, Parts};
use eos_testkit::{FakeCapabilitySecrets, FakeClock, FakeGitHub, FakeSleeper, GITHUB_TOKEN};
use serde_json::Value;
use zeroize::Zeroizing;

pub(crate) const REPO: &str = "acme/game";
/// A head commit.
pub(crate) const HEAD: &str = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
/// A file whose diff is one hunk over lines 27 to 32, line 30 changed.
pub(crate) const PATCH: &str = "@@ -27,6 +27,6 @@ fn main()\n a\n b\n c\n-old\n+new\n d\n e";

pub(crate) struct Rig {
    pub(crate) github: Arc<GitHub>,
    pub(crate) fake: Arc<FakeGitHub>,
    pub(crate) secrets: Arc<FakeCapabilitySecrets>,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) sleeper: Arc<FakeSleeper>,
}

pub(crate) fn rig_with(client_id: &str) -> Rig {
    let fake = Arc::new(FakeGitHub::new());
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let clock = Arc::new(FakeClock::at(1_763_460_000_000));
    let sleeper = Arc::new(FakeSleeper::default());
    let github = Arc::new(GitHub::new(Parts {
        transport: fake.clone(),
        secrets: secrets.clone(),
        clock: clock.clone(),
        sleeper: sleeper.clone(),
        client_id: client_id.into(),
    }));
    Rig { github, fake, secrets, clock, sleeper }
}

/// Signed in, with one pull request by `alice` at [`HEAD`] changing
/// `src/main.rs` ([`PATCH`]).
pub(crate) fn rig() -> Rig {
    let rig = rig_with("Iv1.fake");
    rig.fake.add_pull(REPO, 7, "alice", HEAD, 1_763_400_000_000, &[("src/main.rs", PATCH)]);
    rig
}

/// What the service hands a call: the token, and the delivery's key.
pub(crate) fn ctx(key: Option<&str>) -> ActionContext {
    ActionContext {
        secrets: HashMap::from([("token".to_owned(), Zeroizing::new(GITHUB_TOKEN.to_owned()))]),
        settings: serde_json::json!({}),
        idempotency_key: key.map(str::to_owned),
    }
}

impl Rig {
    pub(crate) async fn call(&self, action: &str, input: Value) -> Result<Value, ActionError> {
        self.call_with(action, input, None).await
    }

    /// The call, its output held to the schema its action declares, as the
    /// service holds it.
    pub(crate) async fn call_with(&self, action: &str, input: Value, key: Option<&str>) -> Result<Value, ActionError> {
        let ctx = ctx(key);
        let output = self.github.call(action, input, &ctx).await?;
        let declared = self.github.manifest().action(action).and_then(|action| action.output.clone());
        if let Some(schema) = declared {
            let mut issues = eos_contracts::Issues::default();
            compile(&schema).expect("a schema").check(&output, &mut issues);
            assert!(issues.is_empty(), "{action} answered outside its schema: {:?}", issues.into_vec());
        }
        Ok(output)
    }

    /// The length of the wait asked for next, once it is asked for.
    pub(crate) async fn next_wait(&self) -> i64 {
        for _ in 0..10_000 {
            if let Some(ms) = self.sleeper.pending().first() {
                return *ms;
            }
            tokio::task::yield_now().await;
        }
        panic!("nothing waited");
    }

    /// The paths of the requests GitHub got, with their method.
    pub(crate) fn requests(&self) -> Vec<String> {
        self.fake.calls().iter().map(|call| format!("{:?} {}", call.method, call.path)).collect()
    }
}
