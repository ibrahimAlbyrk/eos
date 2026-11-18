use eos_contracts::{ModelPrice, Num};
use serde_json::json;

use super::*;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn spend(usd: f64, ms: i64) -> Spend {
    Spend { usd, ms }
}

fn ended(at: i64, outcome: Outcome) -> Ended {
    Ended { at, outcome }
}

#[test]
fn outcomes_are_stored_as_their_words_and_read_back() {
    let words: Vec<&str> = Outcome::ALL.iter().map(|outcome| outcome.as_str()).collect();
    assert_eq!(
        words,
        ["sent_unedited", "sent_edited", "discarded", "auto_sent", "expired", "replaced", "undone", "shown", "nothing"]
    );
    for outcome in Outcome::ALL {
        assert_eq!(Outcome::parse(outcome.as_str()), Some(*outcome));
    }
    assert_eq!(Outcome::parse("delivered_alone"), None, "03's names only");
    let bases: Vec<&str> = Basis::ALL.iter().map(|basis| basis.as_str()).collect();
    assert_eq!(bases, ["history", "trials", "table"]);
}

#[test]
fn the_estimate_is_the_median_of_done_runs_then_of_trials_then_the_table() {
    let table = spend(0.9, 600_000);
    let trials = [spend(0.3, 100_000), spend(0.5, 300_000), spend(0.4, 200_000)];
    let done = [spend(1.0, 60_000), spend(2.0, 120_000), spend(3.0, 180_000), spend(10.0, 1_000)];

    let from_runs = estimate(&done, &trials, table);
    assert_eq!((from_runs.usd, from_runs.ms, from_runs.basis, from_runs.n), (2.5, 90_000, Basis::History, 4));

    let from_trials = estimate(&[], &trials, table);
    assert_eq!((from_trials.usd, from_trials.ms, from_trials.basis, from_trials.n), (0.4, 200_000, Basis::Trials, 3));

    let from_table = estimate(&[], &[], table);
    assert_eq!((from_table.usd, from_table.ms, from_table.basis, from_table.n), (0.9, 600_000, Basis::Table, 0));
}

#[test]
fn only_the_last_twenty_runs_make_the_usual_cost() {
    let mut done = vec![spend(1.0, 1_000); USUAL_RUNS];
    done.extend([spend(50.0, 9_000_000); 21]);
    let usual = estimate(&done, &[], spend(0.0, 0));
    assert_eq!((usual.usd, usual.ms, usual.n), (1.0, 1_000, USUAL_RUNS));
}

#[test]
fn the_table_prices_each_agents_usual_tokens_at_its_model() {
    let price = |input: f64, out: f64| {
        ModelPricing::Flat(ModelPrice {
            r#in: Num(input),
            out: Num(out),
            cache_read: Num(0.0),
            cache_create: Num(0.0),
            cache_create_1h: None,
        })
    };
    let tokens = |tokens_in: i64, tokens_out: i64| Usage {
        tokens_in,
        tokens_out,
        tokens_cache_read: 0,
        tokens_cache_create: 0,
        tokens_cache_create_1h: 0,
        cost_usd: 0.0,
    };
    let (lead, reader) = (tokens(200_000, 20_000), tokens(1_000_000, 10_000));
    let (sonnet, haiku) = (price(3.0, 15.0), price(1.0, 5.0));
    // 0.6 + 0.3, then 1.0 + 0.05; an agent without a price adds nothing.
    let usd = table_usd([(&lead, Some(&sonnet)), (&reader, Some(&haiku)), (&reader, None)]);
    assert!((usd - 1.95).abs() < 1e-9, "{usd}");
}

#[test]
fn runs_share_a_signature_when_every_option_has_the_same_value() {
    let option = |key: &str, default: Value| -> RoutineOption {
        serde_json::from_value(json!({"key": key, "label": key, "type": "text", "default": default, "inline": false}))
            .expect("an option")
    };
    let options = [option("depth", json!("quick")), option("lang", json!("en"))];
    let values = |pairs: Value| -> IndexMap<String, Value> { serde_json::from_value(pairs).expect("values") };

    let defaults = option_signature(&options, &IndexMap::new());
    assert_eq!(defaults, r#"{"depth":"quick","lang":"en"}"#);
    assert_eq!(option_signature(&options, &values(json!({"depth": "quick"}))), defaults, "a default set by hand");
    assert_eq!(
        option_signature(&options, &values(json!({"lang": "en", "depth": "quick", "gone": 1}))),
        defaults,
        "order and options the blueprint no longer has do not count"
    );
    assert_eq!(option_signature(&options, &values(json!({"depth": "deep"}))), r#"{"depth":"deep","lang":"en"}"#);
}

#[test]
fn the_share_counts_sent_unedited_over_sent_and_discarded_in_the_last_seven_days() {
    let now = 100 * DAY;
    let runs = [
        ended(now - 8 * DAY, Outcome::Discarded),
        ended(now - 7 * DAY, Outcome::Discarded),
        ended(now - 6 * DAY, Outcome::SentUnedited),
        ended(now - 5 * DAY, Outcome::SentUnedited),
        ended(now - 4 * DAY, Outcome::SentEdited),
        ended(now - 3 * DAY, Outcome::Discarded),
        ended(now - 2 * DAY, Outcome::AutoSent),
        ended(now - DAY, Outcome::Shown),
        ended(now, Outcome::Nothing),
        ended(now + 1, Outcome::Discarded),
    ];
    assert_eq!(sent_unedited_7d(&runs, now), Some(0.5), "two of four; seven days ago is outside");
    let judged_none = [ended(now, Outcome::AutoSent), ended(now, Outcome::Expired), ended(now, Outcome::Undone)];
    assert_eq!(sent_unedited_7d(&judged_none, now), None);
    assert_eq!(sent_unedited_7d(&[], now), None);
}

#[test]
fn the_baseline_is_the_first_full_week_once_it_is_over() {
    let started = 10 * DAY;
    let runs = [
        ended(started - 1, Outcome::SentUnedited),
        ended(started, Outcome::SentEdited),
        ended(started + DAY, Outcome::SentUnedited),
        ended(started + 3 * DAY, Outcome::Discarded),
        ended(started + 7 * DAY - 1, Outcome::Discarded),
        ended(started + 7 * DAY, Outcome::SentUnedited),
    ];
    assert_eq!(baseline_first_week(&runs, started, started + 7 * DAY - 1), None, "the week is not over yet");
    assert_eq!(baseline_first_week(&runs, started, started + 7 * DAY), Some(0.25));
    assert_eq!(baseline_first_week(&runs, started, started + 300 * DAY), Some(0.25), "kept, whatever came after");
}

#[test]
fn the_median_takes_the_middle_or_the_middle_twos_mean() {
    assert_eq!(median([3.0, 1.0, 2.0]), Some(2.0));
    assert_eq!(median([4.0, 1.0, 3.0, 2.0]), Some(2.5));
    assert_eq!(median([]), None);
}
