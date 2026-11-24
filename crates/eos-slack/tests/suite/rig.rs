//! The capability on `FakeSlack`, a fake clock, waits the test ends and
//! ids the test can count on.

use std::collections::HashMap;
use std::sync::Arc;

use eos_core::capability::{ActionContext, ActionError, BuiltinCapability};
use eos_domain::capability::schema::compile;
use eos_slack::{Parts, Slack};
use eos_testkit::{FakeCapabilitySecrets, FakeClock, FakeSlack, FakeSleeper, SeqIds};
use serde_json::Value;
use zeroize::Zeroizing;

pub(crate) const NOW: i64 = 1_795_000_000_000;
pub(crate) const CHANNEL: &str = "C0GENERAL1";

pub(crate) struct Rig {
    pub(crate) slack: Arc<Slack>,
    pub(crate) fake: Arc<FakeSlack>,
    pub(crate) secrets: Arc<FakeCapabilitySecrets>,
    pub(crate) clock: Arc<FakeClock>,
}

pub(crate) fn rig_with(fake: FakeSlack, client_id: &str) -> Rig {
    let fake = Arc::new(fake);
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let clock = Arc::new(FakeClock::at(NOW));
    let slack = Arc::new(Slack::new(Parts {
        transport: fake.clone(),
        secrets: secrets.clone(),
        clock: clock.clone(),
        sleeper: Arc::new(FakeSleeper::default()),
        ids: Arc::new(SeqIds::new()),
        client_id: client_id.into(),
    }));
    Rig { slack, fake, secrets, clock }
}

/// Signed in, with `#general` and two people.
pub(crate) fn rig() -> Rig {
    let rig = rig_with(FakeSlack::new().signed_in(), "1234.5678");
    rig.fake.conversation(CHANNEL, "general");
    rig.fake.person("U0BOB0001", "bob", "Bob Builder", "bob@acme.dev");
    rig.fake.person("U0ME00001", "me", "Me Myself", "me@acme.dev");
    rig
}

impl Rig {
    /// What the service hands a call: the token pair, ending in 12 hours.
    pub(crate) fn ctx(&self, key: Option<&str>) -> ActionContext {
        let pair = self.fake.token_secret(NOW + 12 * 60 * 60 * 1000);
        ActionContext {
            secrets: HashMap::from([("token".to_owned(), Zeroizing::new(pair))]),
            settings: serde_json::json!({}),
            idempotency_key: key.map(str::to_owned),
        }
    }

    pub(crate) async fn call(&self, action: &str, input: Value) -> Result<Value, ActionError> {
        self.call_in(action, input, &self.ctx(None)).await
    }

    /// The call, its output held to the schema its action declares.
    pub(crate) async fn call_in(&self, action: &str, input: Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let output = self.slack.call(action, input, ctx).await?;
        let declared = self.slack.manifest().action(action).and_then(|action| action.output.clone());
        if let Some(schema) = declared {
            let mut issues = eos_contracts::Issues::default();
            compile(&schema).expect("a schema").check(&output, &mut issues);
            assert!(issues.is_empty(), "{action} answered outside its schema: {:?}", issues.into_vec());
        }
        Ok(output)
    }
}
