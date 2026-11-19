//! The health check, the rate limits and the time an action may take.

use eos_core::Clock;
use eos_core::capability::{ActionError, BuiltinCapability, FailureKind};
use eos_domain::capability::check::check_builtin;
use eos_domain::capability::health::Event;
use serde_json::json;

use crate::rig::{REPO, ctx, rig};

#[tokio::test]
async fn the_manifest_passes_the_built_in_check() {
    let rig = rig();
    assert_eq!(check_builtin(rig.github.manifest()), []);
    assert_eq!(rig.github.manifest().id, "github");
}

#[tokio::test]
async fn the_check_reads_the_user_and_wants_the_repo_scope_and_a_401_asks_for_sign_in() {
    let rig = rig();
    assert_eq!(rig.github.health(&ctx(None)).await, Event::Passed);
    assert_eq!(rig.call("check", json!({})).await, Ok(json!({ "ok": true })));
    assert_eq!(rig.requests()[0], "Get /user");

    rig.fake.set_scopes("read:org");
    assert_eq!(rig.github.health(&ctx(None)).await, Event::Unauthorized, "signed in without repo");

    rig.fake.set_scopes("repo");
    rig.fake.revoke();
    assert_eq!(rig.github.health(&ctx(None)).await, Event::Unauthorized);
    let failed = rig.call("list_pull_requests", json!({ "repo": REPO })).await;
    assert_eq!(failed, Err(ActionError::Failed { kind: FailureKind::Unauthorized }));
}

#[tokio::test]
async fn a_rate_limit_answer_is_rate_limited_and_nothing_goes_until_github_said() {
    let rig = rig();
    let reset_s = rig.clock.now_ms() / 1000 + 120;
    rig.fake.limit_next(403, &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", &reset_s.to_string())]);
    let limited = rig.call("list_pull_requests", json!({ "repo": REPO })).await;
    assert_eq!(limited, Err(ActionError::RateLimited { retry_after_s: 120 }));
    assert_eq!(rig.github.health(&ctx(None)).await, Event::RateLimited, "still limited: the check waits too");
    assert_eq!(rig.fake.calls().len(), 1, "nothing was sent while GitHub asked to wait");

    rig.clock.advance(120_000);
    rig.call("list_pull_requests", json!({ "repo": REPO })).await.expect("the wait is over");
    rig.fake.limit_next(429, &[("retry-after", "30")]);
    let limited = rig.call("get_pull_request", json!({ "repo": REPO, "number": 7 })).await;
    assert_eq!(limited, Err(ActionError::RateLimited { retry_after_s: 30 }));
}

#[tokio::test]
async fn an_action_that_hangs_ends_as_timed_out_after_its_thirty_seconds() {
    let rig = rig();
    rig.fake.hang();
    let github = rig.github.clone();
    let call =
        tokio::spawn(
            async move { github.call("get_pull_request", json!({ "repo": REPO, "number": 7 }), &ctx(None)).await },
        );
    assert_eq!(rig.next_wait().await, 30_000);
    rig.sleeper.wake();
    assert_eq!(call.await.expect("joins"), Err(ActionError::Timeout));
}
