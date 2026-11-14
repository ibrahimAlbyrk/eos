//! The catalog's reads, staleness, failures and invalidations. Every read is
//! held open until the test answers it; events are counted in lane order.

#![allow(clippy::unwrap_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_contracts::{ArtifactCatalog, ArtifactSummary};
use eos_core::BoxFuture;
use eos_core::accounts::PlanAccess;
use eos_core::net::ArtifactSource;
use eos_domain::accounts::PlanLoginRecord;
use eos_domain::time::iso_from_ms;
use eos_mod_artifacts::{ARTIFACTS_CHANGE, Catalog, Parts};
use eos_runtime::bus::EventReceiver;
use eos_runtime::{Kernel, KernelOptions};
use eos_testkit::{FakeClock, FakeSleeper};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

type Listed = Result<Vec<ArtifactSummary>, String>;

struct Call {
    login: String,
    reply: oneshot::Sender<Listed>,
}

impl Call {
    fn answer(self, listed: Listed) {
        let _ = self.reply.send(listed);
    }
}

struct Source(mpsc::UnboundedSender<Call>);

impl ArtifactSource for Source {
    fn list<'a>(&'a self, login_id: &'a str) -> BoxFuture<'a, Listed> {
        let (reply, answer) = oneshot::channel();
        let _ = self.0.send(Call { login: login_id.to_owned(), reply });
        Box::pin(async move { answer.await.unwrap_or_else(|_| Err("never answered".into())) })
    }
}

#[derive(Default)]
struct Logins(Mutex<Vec<PlanLoginRecord>>);

impl Logins {
    fn set(&self, logins: &[(&str, &str, Option<&str>)]) {
        *self.0.lock().unwrap() = logins
            .iter()
            .map(|(id, label, email)| PlanLoginRecord {
                id: (*id).into(),
                provider: "anthropic".into(),
                label: (*label).into(),
                email: email.map(str::to_owned),
                store_dir: format!("/accounts/claude-{id}"),
                created_at: String::new(),
            })
            .collect();
    }
}

impl PlanAccess for Logins {
    fn logins(&self, _provider: &str) -> Vec<PlanLoginRecord> {
        self.0.lock().unwrap().clone()
    }
    fn access_token<'a>(&'a self, _provider: &'a str, _login_id: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    fn token_refused<'a>(&'a self, _provider: &'a str, _login_id: &'a str, _rejected: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }
    fn login_of_worker(&self, _provider: &str, _worker_id: &str) -> Option<String> {
        None
    }
    fn utilization<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Option<f64>> {
        Box::pin(async { None })
    }
}

/// What the test watches and drives.
struct Io {
    calls: mpsc::UnboundedReceiver<Call>,
    events: EventReceiver,
    kernel: Kernel,
    clock: Arc<FakeClock>,
    sleeper: Arc<FakeSleeper>,
    logins: Arc<Logins>,
}

const WAIT: Duration = Duration::from_secs(5);

impl Io {
    async fn call(&mut self) -> Call {
        tokio::time::timeout(WAIT, self.calls.recv()).await.expect("a read").expect("the source")
    }

    /// The next `refreshing` the catalog announced.
    async fn event(&mut self) -> bool {
        let event = tokio::time::timeout(WAIT, self.events.recv()).await.expect("an event").expect("the bus");
        event.payload_as::<serde_json::Value>().unwrap()["refreshing"].as_bool().unwrap()
    }

    /// Every lane job posted so far has run.
    async fn lane_settled(&self) {
        self.kernel.ordered.run(|| ()).await.unwrap();
    }

    /// The debounce timer the catalog armed, once its task asked for it.
    async fn armed(&self) -> Vec<i64> {
        self.lane_settled().await;
        for _ in 0..1000 {
            if !self.sleeper.pending().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        self.sleeper.pending()
    }

    fn quiet(&mut self) {
        assert!(self.calls.try_recv().is_err(), "no other read");
    }
}

fn bench(logins: &[(&str, &str, Option<&str>)]) -> (Arc<Catalog>, Io) {
    let clock = Arc::new(FakeClock::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
    let (tx, calls) = mpsc::unbounded_channel();
    let access = Arc::new(Logins::default());
    access.set(logins);
    let sleeper = Arc::new(FakeSleeper::default());
    let events = kernel.bus.subscribe(ARTIFACTS_CHANGE.name(), 64);
    let catalog = Catalog::new(Parts {
        source: Arc::new(Source(tx)),
        access: access.clone(),
        clock: clock.clone(),
        sleeper: sleeper.clone(),
        lane: kernel.ordered.clone(),
        bus: kernel.bus.clone(),
    });
    (catalog, Io { calls, events, kernel, clock, sleeper, logins: access })
}

fn row(slug: &str, updated_at: &str, login: &str) -> ArtifactSummary {
    serde_json::from_value(json!({
        "slug": slug, "url": format!("https://claude.ai/artifact/{slug}"), "title": slug, "kind": "Page",
        "rel": "mine", "updatedAt": updated_at, "loginId": login,
    }))
    .unwrap()
}

fn slugs(catalog: &ArtifactCatalog) -> Vec<&str> {
    catalog.artifacts.iter().map(|a| a.slug.as_str()).collect()
}

const PERSONAL: &[(&str, &str, Option<&str>)] = &[("a", "Personal", Some("me@x.com"))];
const TWO: &[(&str, &str, Option<&str>)] = &[("a", "A", None), ("b", "B", None)];

#[tokio::test]
async fn one_read_per_sign_in_at_a_time_concurrent_refreshes_share_it() {
    let (catalog, mut io) = bench(PERSONAL);
    let (one, two, ()) = tokio::join!(catalog.refresh(), catalog.refresh(), async {
        assert!(io.event().await);
        let call = io.call().await;
        assert_eq!(call.login, "a");
        call.answer(Ok(vec![row("s1", "2026-10-29T10:00:00Z", "a")]));
        assert!(!io.event().await);
    });
    let (one, two) = (one.unwrap(), two.unwrap());
    assert_eq!(one, two);
    assert_eq!(slugs(&one), ["s1"]);
    assert_eq!(
        serde_json::to_value(&one.accounts).unwrap(),
        json!([{
            "loginId": "a", "label": "Personal", "email": "me@x.com", "count": 1,
            "refreshedAt": iso_from_ms(FakeClock::START_MS),
        }])
    );
    assert!(!one.refreshing);
    io.quiet();
}

#[tokio::test]
async fn get_answers_from_memory_and_re_reads_a_sign_in_never_read_or_stale() {
    let (catalog, mut io) = bench(PERSONAL);
    let first = catalog.get().await.unwrap();
    assert!(first.artifacts.is_empty());
    assert!(first.refreshing);
    assert!(io.event().await);
    let call = io.call().await;
    assert!(catalog.get().await.unwrap().refreshing, "a read in flight is not started again");
    call.answer(Ok(vec![row("s1", "2026-10-29T10:00:00Z", "a")]));
    assert!(!io.event().await);

    io.clock.advance(59_000);
    assert!(!catalog.get().await.unwrap().refreshing, "fresh: no read");

    io.clock.advance(1_000);
    let stale = catalog.get().await.unwrap();
    assert_eq!(slugs(&stale), ["s1"], "the old list while it re-reads");
    assert!(stale.refreshing);
    assert!(io.event().await);
    assert_eq!(io.call().await.login, "a");
    io.quiet();
}

#[tokio::test]
async fn announces_when_a_read_starts_and_when_reads_end() {
    let (catalog, mut io) = bench(TWO);
    catalog.get().await.unwrap();
    assert!(io.event().await, "two reads, one flip");
    let mut calls = [io.call().await, io.call().await];
    calls.sort_by(|x, y| x.login.cmp(&y.login));
    let [a, b] = calls;
    a.answer(Ok(vec![row("s1", "2026-10-29T10:00:00Z", "a")]));
    assert!(io.event().await, "b is still being read");
    b.answer(Ok(Vec::new()));
    assert!(!io.event().await);
}

#[tokio::test]
async fn a_failed_read_keeps_the_sign_ins_last_list_and_says_why_and_the_next_success_clears_it() {
    let (catalog, mut io) = bench(PERSONAL);
    let refresh = async |io: &mut Io, listed: Listed| {
        let (catalog, ()) = tokio::join!(catalog.refresh(), async {
            assert!(io.event().await);
            io.call().await.answer(listed);
            assert!(!io.event().await);
        });
        catalog.unwrap()
    };
    let rows = vec![row("s1", "2026-10-29T10:00:00Z", "a"), row("s2", "2026-10-29T09:00:00Z", "a")];
    refresh(&mut io, Ok(rows)).await;

    io.clock.advance(5_000);
    let message = "Sign in to this account again under Settings › Accounts.";
    let failed = refresh(&mut io, Err(message.into())).await;
    assert_eq!(slugs(&failed), ["s1", "s2"]);
    assert_eq!(
        serde_json::to_value(&failed.accounts[0]).unwrap(),
        json!({
            "loginId": "a", "label": "Personal", "email": "me@x.com", "count": 2,
            "refreshedAt": iso_from_ms(FakeClock::START_MS), "error": message,
        })
    );

    // A failure counts as a read for staleness, so get() does not retry it at once.
    assert!(!catalog.get().await.unwrap().refreshing);

    let ok = refresh(&mut io, Ok(vec![row("s3", "2026-10-29T11:00:00Z", "a")])).await;
    assert_eq!(ok.accounts[0].error, None);
    assert_eq!(ok.accounts[0].refreshed_at, Some(iso_from_ms(FakeClock::START_MS + 5_000)));
    assert_eq!(slugs(&ok), ["s3"]);
}

#[tokio::test]
async fn drops_a_sign_in_that_is_gone_and_the_answer_of_a_read_it_had_in_flight() {
    let (catalog, mut io) = bench(TWO);
    let ((), ()) = tokio::join!(async { catalog.refresh().await.map(drop).unwrap() }, async {
        assert!(io.event().await);
        let mut calls = [io.call().await, io.call().await];
        calls.sort_by(|x, y| x.login.cmp(&y.login));
        let [a, b] = calls;
        a.answer(Ok(vec![row("s1", "2026-10-29T10:00:00Z", "a")]));
        assert!(io.event().await);
        b.answer(Ok(vec![row("s2", "2026-10-29T11:00:00Z", "b")]));
        assert!(!io.event().await);
    });

    io.logins.set(&[("b", "B", None)]);
    let c = catalog.get().await.unwrap();
    assert_eq!(slugs(&c), ["s2"]);
    assert_eq!(c.accounts.iter().map(|a| a.login_id.as_str()).collect::<Vec<_>>(), ["b"]);

    io.logins.set(&[("b", "B", None), ("c", "C", None)]);
    catalog.get().await.unwrap();
    assert!(io.event().await);
    let call = io.call().await;
    assert_eq!(call.login, "c");
    io.logins.set(&[("b", "B", None)]);
    call.answer(Ok(vec![row("s3", "2026-10-29T12:00:00Z", "c")]));
    assert!(!io.event().await);
    assert_eq!(slugs(&catalog.get().await.unwrap()), ["s2"]);
}

#[tokio::test]
async fn invalidate_coalesces_a_burst_into_one_read_per_sign_in_after_the_debounce() {
    let (catalog, mut io) = bench(&[("a", "A", None), ("b", "B", None), ("c", "C", None)]);
    catalog.attach();
    catalog.invalidate(Some("a".into()));
    catalog.invalidate(Some("a".into()));
    catalog.invalidate(Some("b".into()));
    catalog.invalidate(Some("gone".into()));
    assert_eq!(io.armed().await, [eos_mod_artifacts::DEBOUNCE_MS]);
    io.quiet();
    assert!(io.sleeper.wake());
    assert!(io.event().await);
    let mut calls = [io.call().await, io.call().await];
    calls.sort_by(|x, y| x.login.cmp(&y.login));
    let [a, b] = calls;
    assert_eq!((a.login.as_str(), b.login.as_str()), ("a", "b"));
    a.answer(Ok(Vec::new()));
    assert!(io.event().await);
    b.answer(Ok(Vec::new()));
    assert!(!io.event().await);
    io.quiet();

    catalog.invalidate(Some("a".into()));
    catalog.invalidate(None);
    assert_eq!(io.armed().await, [eos_mod_artifacts::DEBOUNCE_MS], "one timer for the burst");
    assert!(io.sleeper.wake());
    assert!(io.event().await);
    let mut logins = vec![io.call().await.login, io.call().await.login, io.call().await.login];
    logins.sort();
    assert_eq!(logins, ["a", "b", "c"], "no sign-in named = every sign-in");
}

#[tokio::test]
async fn an_invalidation_during_a_read_reads_again_once_that_read_ends() {
    let (catalog, mut io) = bench(PERSONAL);
    let (first, ()) = tokio::join!(catalog.refresh(), async {
        assert!(io.event().await);
        let call = io.call().await;
        catalog.invalidate(Some("a".into()));
        catalog.invalidate(Some("a".into()));
        assert_eq!(io.armed().await.len(), 1);
        assert!(io.sleeper.wake());
        io.lane_settled().await;
        // The flush ran on the lane after the wake; it starts nothing while a read is in flight.
        io.lane_settled().await;
        io.quiet();
        call.answer(Ok(vec![row("s1", "2026-10-29T10:00:00Z", "a")]));
        assert!(io.event().await, "the follow-up read keeps it refreshing");
    });
    assert_eq!(slugs(&first.unwrap()), ["s1"]);
    let follow_up = io.call().await;
    assert_eq!(follow_up.login, "a");
    assert!(catalog.get().await.unwrap().refreshing);
    follow_up.answer(Ok(vec![row("s2", "2026-10-29T11:00:00Z", "a"), row("s1", "2026-10-29T10:00:00Z", "a")]));
    assert!(!io.event().await);
    let last = catalog.get().await.unwrap();
    assert_eq!(slugs(&last), ["s2", "s1"]);
    assert!(!last.refreshing);
    io.quiet();
}
