//! The `github.pulls` source: a first poll is the baseline, later ones give
//! what changed as signals of outside text, the cursor goes back as it came.

use eos_contracts::{Fact, ItemRef};
use eos_core::capability::CapabilityHealth;
use eos_core::signals::{PollRequest, Scope, SourceError};
use eos_domain::capability::health::{HealthState, StateCode};
use eos_domain::capability::manifest::FactType;

use crate::github::{PATCH, REPO, github};

fn request(cursor: Option<serde_json::Value>) -> PollRequest {
    let scope: Scope = [("repo".to_owned(), REPO.to_owned())].into_iter().collect();
    PollRequest { scope, cursor, wait_ms: 0, focus: None }
}

#[tokio::test]
async fn a_poll_after_the_baseline_turns_new_pull_requests_into_signals() {
    let rig = github().await;
    let sources = rig.service().signal_sources();
    assert!(sources.get("github.issues").is_none());
    assert!(sources.get("mail.pulls").is_none());
    let source = sources.get("github.pulls").expect("the source");
    let paths = source.facts().iter().find(|fact| fact.name == "paths").map(|fact| fact.kind);
    assert_eq!(paths, Some(FactType::Strings));

    let first = source.poll(request(None)).await.expect("polls");
    assert!(first.baseline && first.items.is_empty(), "what is open already is not news");
    assert_eq!(first.poll_after_ms, Some(60_000));

    let unchanged = source.poll(request(Some(first.cursor.clone()))).await.expect("polls");
    assert!(unchanged.items.is_empty());
    assert_eq!(unchanged.cursor, first.cursor, "the cursor goes back as it came");

    rig.fake.add_pull(REPO, 8, "bob", "ab12", 1_763_450_000_000, &[("src/net.rs", PATCH)]);
    let page = source.poll(request(Some(unchanged.cursor))).await.expect("polls");
    assert!(!page.baseline);
    assert_eq!(page.items.len(), 1);
    let signal = &page.items[0];
    assert_eq!(signal.key, "github:pr:acme/game#8@ab12");
    assert_eq!((signal.subject.as_str(), signal.kind.as_str()), ("github:pr:acme/game#8", "opened"));
    assert_eq!(signal.version.as_deref(), Some("ab12"));
    assert_eq!(signal.facts.get("paths"), Some(&Fact::List(vec!["src/net.rs".into()])));
    let item: ItemRef = serde_json::from_value(signal.item.clone()).expect("a run's item");
    assert!(item.untrusted, "a pull request is outside text to whoever runs on it");
    assert_eq!(item.key.as_deref(), Some("github:pr:acme/game#8@ab12"));
    assert_eq!((item.kind.as_str(), item.version.as_deref()), ("github.pull_request", Some("ab12")));
}

#[tokio::test]
async fn a_refused_sign_in_reads_as_unauthorized_and_marks_the_capability() {
    let rig = github().await;
    rig.fake.revoke();
    let source = rig.service().signal_sources().get("github.pulls").expect("the source");
    let failed = source.poll(request(None)).await.expect_err("refused");
    assert_eq!(failed, SourceError::Unauthorized);

    let health: &dyn CapabilityHealth = rig.service().as_ref();
    health.report("github", &SourceError::Unreachable).await.expect("reports");
    health.report("github", &SourceError::Gone).await.expect("reports");
    let state = eos_core::capability::CapabilityRegistry::state(rig.service().as_ref(), "github").await.expect("reads");
    let state = state.expect("github");
    assert_eq!(
        (state.state, state.code),
        (HealthState::NeedsSignIn, Some(StateCode::Http401)),
        "a repository that is gone says nothing of the capability"
    );
    health.report("github", &SourceError::Unauthorized).await.expect("reports");
    let state = eos_core::capability::CapabilityRegistry::state(rig.service().as_ref(), "github").await.expect("reads");
    assert_eq!(state.expect("github").state, HealthState::NeedsSignIn);
}
