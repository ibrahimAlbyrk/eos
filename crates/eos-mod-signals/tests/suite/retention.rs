//! Old signals are cleared once an hour: facts after 7 days and rows after
//! 30 unless a run that still exists took them, the oldest no run took first
//! past 100,000 rows, and stopped sources 30 days after they stopped.

use std::sync::Arc;

use eos_mod_signals::{FACTS_KEPT_MS, ROWS_KEPT_MS, ROWS_MAX, SWEEP_EVERY_MS};
use eos_runtime::module::Module;

use crate::rig::{Bench, SOURCE_ID, SavedIntake};

const DAY: i64 = 24 * 60 * 60_000;
const NOW: i64 = 400 * DAY;

/// A signal with facts, received at `at`, its decision naming `run`.
fn signal(bench: &Bench, key: &str, at: i64, run: Option<&str>) {
    bench.temp.exec(&format!(
        "INSERT INTO signals (source_id, key, subject, kind, occurred_at, received_at, facts_json, item_json, \
         depth, state) VALUES ('{SOURCE_ID}', '{key}', '{key}', 'opened', {at}, {at}, '{{\"repo\":\"acme/game\"}}', \
         'null', 0, 'routed')"
    ));
    let run = run.map_or_else(|| "NULL".to_owned(), |run| format!("'{run}'"));
    bench.temp.exec(&format!(
        "INSERT INTO signal_routes (signal_id, routine_id, routine_version, decision, run_id, decided_at) \
         SELECT id, 'rt-a', 'rv-1', 'run', {run}, {at} FROM signals WHERE key = '{key}'"
    ));
}

fn kept(bench: &Bench, key: &str) -> (i64, i64) {
    let rows = bench.temp.count(&format!("SELECT count(*) FROM signals WHERE key = '{key}'"));
    let facts =
        bench.temp.count(&format!("SELECT count(*) FROM signals WHERE key = '{key}' AND facts_json IS NOT NULL"));
    (rows, facts)
}

async fn started(bench: &Bench) -> eos_mod_signals::SignalsModule {
    let module = bench.module(bench.temp.port(), Arc::new(SavedIntake::new(None)), true);
    module.after_ready().await.expect("ready");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
    module
}

async fn pass(bench: &Bench) {
    assert!(bench.sleeper.wake(), "the scheduler sleeps");
    bench.until(|| bench.sleeper.pending().len() == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn facts_go_after_a_week_and_rows_after_a_month_unless_a_run_took_them() {
    let bench = Bench::new(vec![]);
    bench.clock.set(NOW);
    bench.temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('rn-1', 'rt-a', 'standing', 'trigger', '{}', 'done', 0, 'dev-1', 1, 1)",
    );
    let week = NOW - FACTS_KEPT_MS - 1;
    let month = NOW - ROWS_KEPT_MS - 1;
    signal(&bench, "fresh", NOW - DAY, None);
    signal(&bench, "week-old", week, None);
    signal(&bench, "week-old-run", week, Some("rn-1"));
    signal(&bench, "month-old", month, None);
    signal(&bench, "month-old-run", month, Some("rn-1"));
    signal(&bench, "month-old-run-gone", month, Some("rn-gone"));
    let stopped = |id: &str, at: i64| {
        bench.temp.exec(&format!(
            "INSERT INTO signal_sources (id, kind, scope_json, scope_hash, state, interval_ms, stopped_at, \
             created_at, updated_at) VALUES ('{id}', 'capability', '{{}}', '{id}', 'stopped', 60000, {at}, 1, 1)"
        ))
    };
    stopped("src-old", month);
    stopped("src-new", NOW - DAY);

    let module = started(&bench).await;
    assert_eq!(kept(&bench, "fresh"), (1, 1));
    assert_eq!(kept(&bench, "week-old"), (1, 0), "facts cleared");
    assert_eq!(kept(&bench, "week-old-run"), (1, 1), "a run took it");
    assert_eq!(kept(&bench, "month-old"), (0, 0));
    assert_eq!(kept(&bench, "month-old-run"), (1, 1));
    assert_eq!(kept(&bench, "month-old-run-gone"), (0, 0), "its run is gone");
    assert_eq!(bench.temp.count("SELECT count(*) FROM signal_routes"), 4, "with their decisions");
    let sources = bench.temp.count("SELECT count(*) FROM signal_sources WHERE id IN ('src-old', 'src-new')");
    assert_eq!(sources, 1);

    signal(&bench, "month-old-later", month, None);
    pass(&bench).await;
    assert_eq!(kept(&bench, "month-old-later"), (1, 1), "once an hour");
    bench.clock.advance(SWEEP_EVERY_MS);
    pass(&bench).await;
    assert_eq!(kept(&bench, "month-old-later"), (0, 0));
    module.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn past_the_most_rows_the_oldest_no_run_took_go_first_a_thousand_at_a_time() {
    let bench = Bench::new(vec![]);
    bench.clock.set(NOW);
    bench.temp.exec(
        "INSERT INTO runs (id, routine_id, kind, origin, input, state, priority, device, created_at, updated_at) \
         VALUES ('rn-1', 'rt-a', 'standing', 'trigger', '{}', 'done', 0, 'dev-1', 1, 1)",
    );
    signal(&bench, "oldest-run", NOW - DAY, Some("rn-1"));
    let extra = 2_500;
    bench.temp.exec(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {}) \
         INSERT INTO signals (source_id, key, subject, kind, occurred_at, received_at, item_json, depth, state) \
         SELECT '{SOURCE_ID}', 'k' || i, 'k' || i, 'opened', {NOW}, {NOW}, 'null', 0, 'routed' FROM n",
        ROWS_MAX + extra - 1
    ));
    let _module = started(&bench).await;
    assert_eq!(bench.temp.count("SELECT count(*) FROM signals"), ROWS_MAX);
    assert_eq!(kept(&bench, "oldest-run").0, 1, "a run took it");
    assert_eq!(kept(&bench, "k1").0, 0, "the oldest no run took went");
    assert_eq!(kept(&bench, &format!("k{extra}")).0, 0, "over three jobs");
    assert_eq!(kept(&bench, &format!("k{}", extra + 1)).0, 1);
}
