//! The poll driver: each source on its own clock, the cursor handed back,
//! backoff after failures, a source that lost its sign-in stopped and its
//! capability told, the first page a baseline, a capped run of pages, the
//! catch-up after a gap, and a source nobody reads kept for later.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::signals::{PollPage, SourceError};
use eos_core::store::StoredSignalSource;
use eos_mod_signals::{BACKOFF_MS, PAGES_MAX, SignalsModule, WAKE_RETRY_MS};
use eos_runtime::module::Module;
use serde_json::{Value, json};

use crate::rig::{Bench, SOURCE_ID, SavedIntake, page, pull, routine};

const EVENTS: [&str; 2] = ["opened", "updated"];
const MINUTE: i64 = 60_000;

fn reader() -> Bench {
    Bench::new(vec![routine("rt-a", RoutineState::Active, &EVENTS, None)])
}

fn row(bench: &Bench) -> StoredSignalSource {
    let found = bench.temp.store.read_blocking(|tx| tx.signal_sources().find(SOURCE_ID)).expect("reads");
    found.expect("the source")
}

/// Starts the module; its first pass polls the source, which settles.
async fn started(bench: &Bench) -> SignalsModule {
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.after_ready().await.expect("ready");
    bench.until(|| row(bench).next_poll_at.is_some() || row(bench).state == "needs-attention").await;
    module
}

/// Moves the clock to when the source is due, starts a pass and waits until
/// the poll settled.
async fn poll_due(bench: &Bench) -> i64 {
    let at = row(bench).next_poll_at.expect("due later");
    bench.clock.set(at);
    kick(bench, "routine:change");
    bench.until(|| row(bench).next_poll_at.is_none_or(|next| next > at)).await;
    at
}

fn kick(bench: &Bench, topic: &'static str) {
    bench.bus.publish_raw(topic, None, b"{}".as_slice().into());
}

fn signals(bench: &Bench) -> i64 {
    bench.temp.count("SELECT count(*) FROM signals")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_is_polled_on_its_own_clock_and_an_empty_page_moves_only_when_it_was_read() {
    let bench = reader();
    bench.pulls.page(page(vec![pull(1, "aaa", "opened", false, &[])], json!({"etag": "e1"})));
    let module = started(&bench).await;
    let first = row(&bench);
    let wait = first.next_poll_at.expect("next") - 5_000;
    assert!((60_000..=66_000).contains(&wait), "a minute and a fixed part of its tenth: {wait}");

    // The source answers "nothing new" with the cursor it was given.
    let at = poll_due(&bench).await;
    let second = row(&bench);
    assert_eq!(second.next_poll_at, Some(at + wait), "the same offset every time");
    assert_eq!(second.cursor_json, first.cursor_json, "handed back as it was");
    assert_eq!((second.last_poll_at, second.last_signal_at), (Some(at), first.last_signal_at));
    assert_eq!(signals(&bench), 1);
    assert_eq!(bench.pulls.requests()[1].cursor, Some(json!({"etag": "e1"})));

    // Another scope gets a row of its own, polled every minute by default.
    let mut other = routine("rt-b", RoutineState::Active, &EVENTS, None);
    other.when = serde_json::from_value(
        json!({ "on": [{ "source": "github.pulls", "scope": { "repo": "acme/other" }, "events": EVENTS }] }),
    )
    .expect("a When");
    bench.directory.set(vec![routine("rt-a", RoutineState::Active, &EVENTS, None), other]);
    kick(&bench, "routine:change");
    bench.until(|| bench.temp.count("SELECT count(*) FROM signal_sources WHERE interval_ms = 60000") == 2).await;
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_service_backs_off_step_by_step_until_a_good_poll() {
    let bench = reader();
    let module = started(&bench).await;
    for _ in 0..6 {
        bench.pulls.fail(SourceError::Unreachable);
    }
    let mut waits = Vec::new();
    for _ in 0..6 {
        let at = poll_due(&bench).await;
        let row = row(&bench);
        assert_eq!((row.state.as_str(), row.error_kind.as_deref()), ("backing-off", Some("unreachable")));
        waits.push(row.next_poll_at.expect("next") - at);
    }
    assert_eq!(waits, [BACKOFF_MS.to_vec(), vec![BACKOFF_MS[4]]].concat(), "the last step repeats");
    assert_eq!(row(&bench).failures, 6);

    poll_due(&bench).await;
    let row = row(&bench);
    assert_eq!((row.state.as_str(), row.error_kind, row.failures), ("active", None, 0));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limited_source_waits_for_its_time_and_counts_no_failure() {
    let bench = reader();
    let module = started(&bench).await;
    let retry_at = row(&bench).next_poll_at.expect("next") + 10 * MINUTE;
    bench.pulls.fail(SourceError::RateLimited { retry_at });
    poll_due(&bench).await;
    let row = row(&bench);
    assert_eq!((row.next_poll_at, row.failures, row.error_kind.as_deref()), (Some(retry_at), 0, Some("rate-limited")));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_that_lost_its_sign_in_or_its_repository_stops_and_tells_its_capability() {
    for (error, kind) in [(SourceError::Unauthorized, "unauthorized"), (SourceError::Gone, "gone")] {
        // Polling stops: nothing is due until the capability is mended.
        let bench = reader();
        bench.pulls.fail(error.clone());
        let module = started(&bench).await;
        let stopped = row(&bench);
        assert_eq!((stopped.state.as_str(), stopped.error_kind.as_deref()), ("needs-attention", Some(kind)));
        assert_eq!(stopped.next_poll_at, None, "polling stops");
        bench.until(|| bench.health.reports().len() == 1).await;
        assert_eq!(bench.health.reports(), [("github".to_owned(), error)]);
        module.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn right_after_a_wake_an_unreachable_service_is_tried_again_soon_without_a_failure() {
    let bench = reader();
    let module = started(&bench).await;
    let at = row(&bench).next_poll_at.expect("next");
    bench.pulls.fail(SourceError::Unreachable);
    bench.clock.set(at - 1_000);
    kick(&bench, "system:wake");
    bench.clock.set(at);
    kick(&bench, "routine:change");
    bench.until(|| row(&bench).next_poll_at.is_some_and(|next| next > at)).await;
    let row = row(&bench);
    assert_eq!((row.next_poll_at, row.failures, row.state.as_str()), (Some(at + WAKE_RETRY_MS), 0, "active"));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_page_of_a_new_source_is_the_starting_point_and_starts_nothing() {
    let bench = reader();
    let first = PollPage {
        baseline: true,
        ..page(vec![pull(1, "a", "opened", false, &[]), pull(2, "b", "opened", false, &[])], json!({}))
    };
    bench.pulls.page(first);
    let module = started(&bench).await;
    bench.until(|| bench.decided("baseline") == 2).await;
    assert!(bench.admitted().is_empty(), "what exists already is not news");
    assert_eq!(bench.received(), 0, "decided in the write that kept them");
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn one_poll_reads_at_most_ten_pages_and_the_next_reads_on_from_there() {
    let bench = reader();
    for n in 1..=12_u64 {
        bench
            .pulls
            .page(PollPage { more: n < 12, ..page(vec![pull(n, "a", "opened", false, &[])], json!({"page": n})) });
    }
    let module = started(&bench).await;
    assert_eq!((bench.pulls.requests().len(), signals(&bench)), (PAGES_MAX, 10));
    assert_eq!(row(&bench).cursor_json.as_deref(), Some(r#"{"page":10}"#));
    poll_due(&bench).await;
    assert_eq!(signals(&bench), 12);
    assert_eq!(bench.pulls.requests()[PAGES_MAX].cursor, Some(json!({"page": 10})));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_poll_after_a_gap_of_over_a_quarter_hour_records_what_it_caught_up_on() {
    let bench = reader();
    let module = started(&bench).await;
    assert_eq!(row(&bench).catch_up_json, None);
    let first = row(&bench).last_poll_at.expect("polled");
    bench.pulls.page(page(vec![pull(1, "a", "opened", false, &[]), pull(2, "b", "opened", false, &[])], json!({})));
    let at = first + 20 * MINUTE;
    bench.clock.set(at);
    kick(&bench, "routine:change");
    bench.until(|| row(&bench).catch_up_json.is_some()).await;
    let catch_up: Value = serde_json::from_str(&row(&bench).catch_up_json.expect("kept")).expect("JSON");
    assert_eq!(catch_up, json!({ "at": at, "items": 2, "gapMs": 20 * MINUTE }));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_no_routine_reads_stops_and_comes_back_from_its_cursor() {
    let bench = reader();
    bench.pulls.page(page(Vec::new(), json!({"etag": "e7"})));
    let module = started(&bench).await;
    bench.directory.set(vec![routine("rt-a", RoutineState::Paused, &EVENTS, None)]);
    kick(&bench, "routine:change");
    bench.until(|| row(&bench).state == "stopped").await;
    let stopped = row(&bench);
    assert!(stopped.stopped_at.is_some());
    assert_eq!(stopped.cursor_json.as_deref(), Some(r#"{"etag":"e7"}"#), "kept");

    bench.directory.set(vec![routine("rt-a", RoutineState::Active, &EVENTS, None)]);
    kick(&bench, "routine:change");
    bench.until(|| bench.pulls.requests().len() == 2).await;
    assert_eq!(bench.pulls.requests()[1].cursor, Some(json!({"etag": "e7"})), "from where it stopped");
    bench.until(|| row(&bench).state == "active").await;
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_that_does_nothing_in_this_run_of_eos_shows_off() {
    let bench = reader();
    bench.pulls.fail(SourceError::Off);
    let module = started(&bench).await;
    let row = row(&bench);
    assert_eq!((row.state.as_str(), row.error_kind, row.failures), ("off", None, 0));
    assert_eq!(signals(&bench), 0);
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_source_whose_interval_changed_is_polled_on_its_new_one() {
    let bench = reader();
    bench.pulls.page(page(Vec::new(), json!({"etag": "e1"})));
    let module = started(&bench).await;
    // As an older version of the source declared: an hour.
    let now = eos_core::Clock::now_ms(bench.clock.as_ref());
    bench.temp.exec(&format!(
        "UPDATE signal_sources SET interval_ms = {}, next_poll_at = {} WHERE id = '{SOURCE_ID}'",
        60 * MINUTE,
        now + 60 * MINUTE
    ));
    kick(&bench, "routine:change");
    bench.until(|| row(&bench).interval_ms == MINUTE).await;
    let next = row(&bench).next_poll_at.expect("due");
    assert!(next <= now + MINUTE, "the next poll keeps to the new interval: {}", next - now);
    module.stop().await;
}
