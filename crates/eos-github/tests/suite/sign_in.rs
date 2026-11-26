//! Signing in with the GitHub CLI's sign-in.

use eos_core::Clock;
use eos_core::capability::{BuiltinCapability, CapabilitySecrets, SignInError};
use eos_domain::capability::health::Event;
use eos_github::CliError;
use eos_testkit::{FakeGhCli, GITHUB_TOKEN, GITHUB_USER_CODE};

use crate::rig::{ctx, rig, rig_with};

async fn kept(rig: &crate::rig::Rig, name: &str) -> Option<String> {
    rig.secrets.read("github", name).await.expect("reads").map(|kept| kept.to_string())
}

#[tokio::test]
async fn a_sign_in_the_cli_already_has_is_taken_without_a_code() {
    let rig = rig();
    rig.cli.sign_in("monalisa-octo", GITHUB_TOKEN);
    let sign_in = rig.github.device_sign_in().expect("GitHub signs in");
    let code = sign_in.start().await.expect("starts");
    assert_eq!((code.user_code.as_str(), code.verification_uri.as_str()), ("", ""), "nothing to enter");
    assert_eq!(sign_in.finish(&code).await, Ok(rig.fake.login()), "the login is the account's label");
    assert_eq!(kept(&rig, "token").await.as_deref(), Some(GITHUB_TOKEN));
    assert_eq!(kept(&rig, "account").await, Some(rig.fake.login()));
    assert_eq!((rig.cli.logins(), rig.cli.installs()), (0, 0));
}

#[tokio::test]
async fn a_signed_out_cli_signs_in_with_a_code_and_its_token_is_kept() {
    let rig = rig();
    rig.cli.next_login("monalisa-octo", GITHUB_TOKEN);
    let code = rig.github.device_sign_in().expect("signs in").start().await.expect("a code");
    assert_eq!(*code.user_code, GITHUB_USER_CODE);
    assert_eq!(code.verification_uri, "https://github.com/login/device");
    assert_eq!(code.expires_at, rig.clock.now_ms() + 900_000, "codes live 15 minutes");
    assert!(!format!("{code:?}").contains(GITHUB_USER_CODE));

    let github = rig.github.clone();
    let finished = tokio::spawn(async move { github.device_sign_in().expect("signs in").finish(&code).await });
    rig.next_wait().await;
    assert_eq!(kept(&rig, "token").await, None, "nothing is kept before the code is entered");
    rig.cli.enter_code();
    assert_eq!(finished.await.expect("joins"), Ok(rig.fake.login()));
    assert_eq!(kept(&rig, "token").await.as_deref(), Some(GITHUB_TOKEN));
    assert_eq!(rig.fake.calls().last().map(|call| (call.path.as_str(), call.signed_in)), Some(("/user", true)));
}

#[tokio::test]
async fn a_token_github_refuses_makes_the_cli_sign_in_again() {
    let rig = rig();
    rig.cli.sign_in("monalisa-octo", "gho_taken_back");
    let code = rig.github.device_sign_in().expect("signs in").start().await.expect("a code");
    assert_eq!(*code.user_code, GITHUB_USER_CODE, "the sign-in gh has no longer works");
    assert_eq!(rig.cli.logins(), 1);
}

#[tokio::test]
async fn a_missing_cli_is_installed_and_one_that_cannot_be_ends_the_sign_in() {
    let rig = rig_with(FakeGhCli::new().missing(true));
    rig.cli.next_login("monalisa-octo", GITHUB_TOKEN);
    rig.github.device_sign_in().expect("signs in").start().await.expect("a code");
    assert_eq!(rig.cli.installs(), 1);

    let rig = rig_with(FakeGhCli::new().missing(false));
    let refused = rig.github.device_sign_in().expect("signs in").start().await.map(drop);
    assert_eq!(refused, Err(SignInError::Failed));
    assert!(rig.fake.calls().is_empty(), "GitHub was never asked");
}

#[tokio::test]
async fn a_code_not_entered_in_time_or_a_failed_cli_ends_the_sign_in_and_keeps_nothing() {
    let rig = rig();
    let sign_in = rig.github.device_sign_in().expect("signs in");
    let code = sign_in.start().await.expect("a code");
    let github = rig.github.clone();
    let finished = tokio::spawn(async move { github.device_sign_in().expect("signs in").finish(&code).await });
    assert_eq!(rig.next_wait().await, 900_000, "the code's life");
    rig.sleeper.wake();
    assert_eq!(finished.await.expect("joins"), Err(SignInError::Expired));

    let code = sign_in.start().await.expect("a code");
    rig.cli.fail_login(CliError::Failed);
    assert_eq!(sign_in.finish(&code).await, Err(SignInError::Failed));
    assert_eq!(sign_in.finish(&code).await, Err(SignInError::Failed), "nothing waits any more");
    assert_eq!(kept(&rig, "token").await, None);
}

/// Signs `rig` in with the sign-in `gh` has.
async fn signed_in(rig: &crate::rig::Rig) {
    rig.cli.sign_in("monalisa-octo", GITHUB_TOKEN);
    let sign_in = rig.github.device_sign_in().expect("signs in");
    let code = sign_in.start().await.expect("starts");
    sign_in.finish(&code).await.expect("signed in");
}

#[tokio::test]
async fn a_refused_token_is_read_again_from_the_cli_for_the_same_account() {
    let rig = rig();
    signed_in(&rig).await;
    // The user signed in again in a terminal, then made another account active.
    let fresh = rig.fake.renew();
    rig.cli.sign_in("monalisa-octo", &fresh);
    rig.cli.sign_in("someone-else", "gho_other_account");
    assert_eq!(rig.github.health(&ctx(None)).await, Event::Passed);
    assert_eq!(kept(&rig, "token").await, Some(fresh), "the account's new token is kept");
}

#[tokio::test]
async fn a_sign_in_taken_back_everywhere_needs_signing_in_again() {
    let rig = rig();
    signed_in(&rig).await;
    rig.fake.revoke();
    assert_eq!(rig.github.health(&ctx(None)).await, Event::Unauthorized);
    rig.cli.sign_out();
    assert_eq!(rig.github.health(&ctx(None)).await, Event::Unauthorized);
    assert_eq!(kept(&rig, "token").await.as_deref(), Some(GITHUB_TOKEN), "nothing new was kept");
}
