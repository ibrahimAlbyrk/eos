//! Signing in to GitHub through the GitHub CLI, with the GitHub capability
//! itself on `FakeGitHub` and `FakeGhCli`: a code shown, pending, signed in
//! and ready; a CLI signed in already; ended by the user; forgotten with its
//! account; out of time; ended while its token is being kept; a CLI that
//! cannot be installed; and who may ask.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use eos_core::BoxFuture;
use eos_core::capability::{ActionContext, ActionError, BuiltinCapability, CapabilitySecrets, DeviceSignIn};
use eos_domain::capability::health::Event;
use eos_domain::capability::manifest::Manifest;
use eos_github::{ACCOUNT, GitHub, Parts};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_testkit::{
    FakeBuiltin, FakeCapabilitySecrets, FakeClock, FakeGhCli, FakeGitHub, FakeSleeper, GITHUB_TOKEN, GITHUB_USER_CODE,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore};

use crate::rig::{MAIL, Rig, rig_with};

const PATH: &str = "/api/capabilities/github/sign-in";
/// How long the sign-in's code lives.
const CODE_MS: i64 = 900_000;

struct SignIn {
    rig: Rig,
    fake: Arc<FakeGitHub>,
    cli: FakeGhCli,
    secrets: Arc<FakeCapabilitySecrets>,
    /// The waits of the sign-in.
    waits: Arc<FakeSleeper>,
}

fn github(
    fake: &Arc<FakeGitHub>,
    cli: &FakeGhCli,
    secrets: &Arc<FakeCapabilitySecrets>,
    waits: &Arc<FakeSleeper>,
) -> GitHub {
    GitHub::new(Parts {
        transport: fake.clone(),
        secrets: secrets.clone(),
        clock: Arc::new(FakeClock::at(1_763_460_000_000)),
        sleeper: waits.clone(),
        cli: Arc::new(cli.clone()),
    })
}

async fn sign_in(cli: FakeGhCli) -> SignIn {
    let fake = Arc::new(FakeGitHub::new());
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let waits = Arc::new(FakeSleeper::default());
    let builtin: Arc<dyn BuiltinCapability> = Arc::new(github(&fake, &cli, &secrets, &waits));
    let rig = rig_with(vec![builtin, Arc::new(FakeBuiltin::new(MAIL))], secrets.clone()).await;
    SignIn { rig, fake, cli, secrets, waits }
}

impl SignIn {
    /// Waits until the sign-in waits for its code to be entered.
    async fn waiting(&self) {
        for _ in 0..10_000 {
            if self.waits.pending() == [CODE_MS] {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("the sign-in never waited for its code");
    }

    /// The attempt's status once it is no longer pending.
    async fn ended(&self) -> Value {
        for _ in 0..10_000 {
            let (status, body) = self.rig.ask(Method::Get, PATH, None).await;
            assert_eq!(status, 200);
            if body["state"] != "pending" {
                return body;
            }
            tokio::task::yield_now().await;
        }
        panic!("the sign-in never ended");
    }

    async fn kept(&self, name: &str) -> Option<String> {
        self.secrets.read("github", name).await.expect("reads").map(|kept| kept.to_string())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_shows_the_code_waits_and_leaves_github_signed_in_and_ready() {
    let s = sign_in(FakeGhCli::new()).await;
    let (status, row) = s.rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(
        (status, row["state"].clone(), row["stateCode"].clone()),
        (200, json!("needs_setup"), json!("secret_missing:token"))
    );

    s.cli.next_login(&s.fake.login(), GITHUB_TOKEN);
    let (status, started) = s.rig.ask(Method::Post, PATH, None).await;
    assert_eq!(status, 200);
    assert_eq!(started["userCode"], GITHUB_USER_CODE);
    assert_eq!(started["verificationUri"], "https://github.com/login/device");
    assert_eq!(started["expiresAt"], 1_763_460_000_000_i64 + CODE_MS);
    assert_eq!(s.rig.ask(Method::Get, PATH, None).await, (200, json!({ "state": "pending" })));

    s.waiting().await;
    s.cli.enter_code();
    assert_eq!(s.ended().await, json!({ "state": "signed_in", "accountLabel": s.fake.login() }));
    assert_eq!(s.kept("token").await.as_deref(), Some(GITHUB_TOKEN));
    let (_, row) = s.rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!((row["state"].clone(), row["accountLabel"].clone()), (json!("ready"), json!(s.fake.login())));
    assert_eq!(s.rig.changes().last().map(String::as_str), Some(r#"{"id":"github","state":"ready"}"#));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cli_signed_in_already_signs_in_without_a_code() {
    let s = sign_in(FakeGhCli::new()).await;
    s.cli.sign_in(&s.fake.login(), GITHUB_TOKEN);
    let (status, started) = s.rig.ask(Method::Post, PATH, None).await;
    assert_eq!(status, 200);
    assert!(started.get("userCode").is_none(), "nothing to enter: {started}");
    assert_eq!(started["verificationUri"], "");
    assert_eq!(s.ended().await, json!({ "state": "signed_in", "accountLabel": s.fake.login() }));
    assert_eq!(s.cli.logins(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn forgetting_the_sign_in_forgets_its_account_too() {
    let s = sign_in(FakeGhCli::new()).await;
    s.cli.sign_in(&s.fake.login(), GITHUB_TOKEN);
    assert_eq!(s.rig.ask(Method::Post, PATH, None).await.0, 200);
    assert_eq!(s.ended().await["state"], "signed_in");
    assert_eq!(s.kept(ACCOUNT).await, Some(s.fake.login()));

    let forget = "/api/capabilities/github/secrets/token";
    assert_eq!(s.rig.ask(Method::Delete, forget, None).await, (200, json!({ "ok": true })));
    assert_eq!(s.kept("token").await, None);
    assert_eq!(s.kept(ACCOUNT).await, None, "the account goes too");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_the_user_ends_stops_waiting_and_one_out_of_time_says_expired() {
    let s = sign_in(FakeGhCli::new()).await;
    assert_eq!(s.rig.ask(Method::Post, PATH, None).await.0, 200);
    s.waiting().await;
    assert_eq!(s.rig.ask(Method::Delete, PATH, None).await, (200, json!({ "ok": true })));
    assert_eq!(s.rig.ask(Method::Get, PATH, None).await.0, 404, "no attempt left");
    for _ in 0..10_000 {
        if s.waits.pending().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(s.waits.pending(), Vec::<i64>::new(), "nothing waits any more");

    assert_eq!(s.rig.ask(Method::Post, PATH, None).await.0, 200);
    s.waiting().await;
    assert!(s.waits.wake(), "the code's life ends");
    assert_eq!(s.ended().await, json!({ "state": "expired" }));
    assert_eq!(s.kept("token").await, None);
    let (_, row) = s.rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(row["state"], "needs_setup");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cli_that_cannot_be_installed_does_not_start_the_sign_in() {
    let s = sign_in(FakeGhCli::new().missing(false)).await;
    assert_eq!(s.rig.ask(Method::Post, PATH, None).await.0, 502);
    assert!(s.fake.calls().is_empty(), "GitHub was never asked");
    assert_eq!(s.rig.ask(Method::Get, PATH, None).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_capability_that_signs_in_by_a_code_and_only_this_computer_may_ask() {
    let s = sign_in(FakeGhCli::new()).await;
    for method in [Method::Post, Method::Get, Method::Delete] {
        for id in ["mail", "nothing-here"] {
            let path = format!("/api/capabilities/{id}/sign-in");
            assert_eq!(s.rig.ask(method, &path, None).await.0, 404, "{method:?} {id}");
        }
        assert_eq!(s.rig.ask_as(Caller::UNTRUSTED, method, PATH, None).await.0, 403, "without the ui token");
        let peer = Caller::Peer { device: "AB:CD".into(), human: true };
        assert_eq!(s.rig.ask_as(peer, method, PATH, None).await.0, 403, "a paired computer");
        let phone = Caller::Phone { grant: Tier::Low, mutate: true };
        assert_eq!(s.rig.ask_as(phone, method, PATH, None).await.0, 403, "the phone");
    }
    assert!(s.fake.calls().is_empty());
}

/// GitHub whose first check waits until the test lets it go: the window
/// after a sign-in kept its token, while its label is written and checked.
struct FirstCheckHeld {
    github: GitHub,
    checks: AtomicUsize,
    entered: Notify,
    gate: Semaphore,
}

impl BuiltinCapability for FirstCheckHeld {
    fn manifest(&self) -> &Manifest {
        self.github.manifest()
    }

    fn call<'a>(
        &'a self,
        action: &'a str,
        input: Value,
        ctx: &'a ActionContext,
    ) -> BoxFuture<'a, Result<Value, ActionError>> {
        self.github.call(action, input, ctx)
    }

    fn health<'a>(&'a self, ctx: &'a ActionContext) -> BoxFuture<'a, Event> {
        Box::pin(async move {
            if self.checks.fetch_add(1, Ordering::SeqCst) == 0 {
                self.entered.notify_one();
                self.gate.acquire().await.expect("the gate stays open").forget();
            }
            self.github.health(ctx).await
        })
    }

    fn device_sign_in(&self) -> Option<&dyn DeviceSignIn> {
        self.github.device_sign_in()
    }

    fn undeclared_secrets(&self) -> &[&'static str] {
        self.github.undeclared_secrets()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_ended_after_its_token_was_kept_ends_signed_out() {
    let fake = Arc::new(FakeGitHub::new());
    let cli = FakeGhCli::new();
    cli.sign_in(&fake.login(), GITHUB_TOKEN);
    let secrets = Arc::new(FakeCapabilitySecrets::new());
    let waits = Arc::new(FakeSleeper::default());
    let held = Arc::new(FirstCheckHeld {
        github: github(&fake, &cli, &secrets, &waits),
        checks: AtomicUsize::new(0),
        entered: Notify::new(),
        gate: Semaphore::new(0),
    });
    let rig = rig_with(vec![held.clone(), Arc::new(FakeBuiltin::new(MAIL))], secrets.clone()).await;
    let s = SignIn { rig, fake, cli, secrets, waits };

    assert_eq!(s.rig.ask(Method::Post, PATH, None).await.0, 200);
    tokio::time::timeout(std::time::Duration::from_secs(10), held.entered.notified())
        .await
        .expect("the sign-in checks its kept token");

    assert_eq!(s.rig.ask(Method::Delete, PATH, None).await, (200, json!({ "ok": true })));
    assert_eq!(s.kept("token").await, None, "the cancel wins: no token stays");
    assert_eq!(s.kept(ACCOUNT).await, None, "nor its account");
    let (_, row) = s.rig.ask(Method::Get, "/api/capabilities/github", None).await;
    assert_eq!(row["state"], "needs_setup");
    assert!(row["accountLabel"].is_null(), "no account is named: {row}");
    assert_eq!(s.rig.ask(Method::Get, PATH, None).await.0, 404, "no attempt left");
}
