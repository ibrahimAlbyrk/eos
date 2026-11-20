//! What routines read: items to pick and past ones, recognisers, whether a
//! review fits its action, what is missing, and a pull request's checkout.

use eos_core::capability::{ActionError, CapabilityReads, PastItemFilter};
use eos_domain::capability::health::HealthState;

use crate::github::{HEAD, REPO, github, pull_item, review};

#[tokio::test]
async fn items_to_pick_and_past_ones_come_from_the_sources_kind() {
    let rig = github().await;
    let reads: &dyn CapabilityReads = rig.service().as_ref();
    let items = reads.candidates("github.pulls", None, 10).await.expect("reads");
    assert_eq!(items.iter().map(|item| item.key.as_str()).collect::<Vec<_>>(), ["github:pr:acme/game#7"]);
    let filter = PastItemFilter {
        scope: [("repo".to_owned(), REPO.to_owned())].into_iter().collect(),
        query: Some("networking".into()),
    };
    let past = reads.past_items("github.pulls", &filter, 10).await.expect("reads");
    assert_eq!(past.len(), 1);
    let searched = rig.fake.calls().into_iter().map(|call| call.path).rfind(|path| path.starts_with("/search"));
    let searched = searched.expect("a search");
    assert!(searched.contains("repo%3Aacme%2Fgame") && searched.contains("networking"), "{searched}");
    assert!(!searched.contains("is%3Aopen"), "done ones too: {searched}");
    assert!(reads.candidates("github.issues", None, 10).await.is_err());

    let recognisers = reads.recognisers().await.expect("reads");
    assert_eq!(recognisers.len(), 1);
    assert_eq!((recognisers[0].kind.as_str(), recognisers[0].noun.as_str()), ("github.pull_request", "pull request"));
    assert!(recognisers[0].patterns[0].starts_with("https://github"));
}

#[tokio::test]
async fn a_review_is_held_to_the_input_of_the_action_that_sends_it() {
    let rig = github().await;
    let reads: &dyn CapabilityReads = rig.service().as_ref();
    let item = pull_item(7, HEAD);
    assert_eq!(reads.validate_result("github.review", &review("post_review", "COMMENT", 30), &item).await, Ok(()));
    let broken = reads.validate_result("github.review", &review("post_review", "MAYBE", 30), &item).await;
    assert_eq!(broken, Err(vec!["part `event`: `MAYBE` is not one of `COMMENT`, `REQUEST_CHANGES`.".to_owned()]));
    let mut lineless = review("post_review", "COMMENT", 30);
    lineless.parts[2].meta.remove("line");
    assert!(reads.validate_result("github.review", &lineless, &item).await.is_err());
    assert!(reads.validate_result("mail", &review("post_review", "COMMENT", 30), &item).await.is_err());
}

#[tokio::test]
async fn what_a_routine_lacks_and_where_a_pull_requests_code_is() {
    let rig = github().await;
    let reads: &dyn CapabilityReads = rig.service().as_ref();
    let missing = reads.missing(&["github".into(), "mail".into()]).await.expect("reads");
    assert_eq!(missing.len(), 1);
    assert_eq!((missing[0].id.as_str(), missing[0].health.is_none()), ("mail", true));
    rig.fake.revoke();
    let _ = rig.service().check("github").await.expect("checks");
    let missing = reads.missing(&["github".into()]).await.expect("reads");
    assert_eq!(missing[0].health.as_ref().map(|health| health.state), Some(HealthState::NeedsSignIn));
    assert_eq!(reads.list().await.expect("reads").len(), 1);

    let rig = github().await;
    let reads: &dyn CapabilityReads = rig.service().as_ref();
    let checkout = reads.checkout(&pull_item(7, "older")).await.expect("a checkout");
    assert_eq!(checkout.remote, "https://github.com/acme/game.git");
    assert_eq!((checkout.refspec.as_str(), checkout.sha.as_str()), ("pull/7/head", HEAD), "the head now");
    let mut link = pull_item(7, HEAD);
    link.kind = "link".into();
    assert_eq!(reads.checkout(&link).await, Err(ActionError::NotFound));
}
