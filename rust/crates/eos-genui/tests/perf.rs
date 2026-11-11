//! The partial-JSON and markup parsers run on streamed tool input, many times a
//! second per stream, each time over everything received so far. One parse must
//! stay linear in the input, whatever the input is.
//!
//! `cargo test --release -p eos-genui --test perf -- --nocapture` prints the timings.

use std::time::{Duration, Instant};

use eos_genui::markup::{parse_markup, parse_partial};
use eos_genui::partial_json::{DEFAULT_PARTIAL_KEYS, parse_loose_json, parse_partial_json};
use eos_genui::{Value, validate_view};

const KB: usize = 1024;

fn best_of(runs: usize, f: impl Fn()) -> Duration {
    (0..runs)
        .map(|_| {
            let start = Instant::now();
            f();
            start.elapsed()
        })
        .min()
        .unwrap_or_default()
}

// A `present` input of about `bytes` bytes: mostly data rows, then markup.
fn present_json(bytes: usize) -> String {
    let mut rows = String::new();
    let mut i = 0;
    while rows.len() < bytes * 3 / 4 {
        rows.push_str(&format!(
            r#"{{"id":"p{i}","type":"Place","name":"Mekân \"{i}\" 😀","rating":4.{},"price":{},"geo":[40.98{i},29.02],"tags":["sea","a\tb"],"hours":{{"until":"23:00"}}}},"#,
            i % 10,
            1 + i % 4
        ));
        i += 1;
    }
    rows.pop();
    let ui = markup(bytes / 4).replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    format!(r#"{{"title":"Kadıköy","tone":"green","data":{{"places":[{rows}]}},"ui":"{ui}","summary":"Places."}}"#)
}

fn markup(bytes: usize) -> String {
    let mut out = String::new();
    let mut i = 0;
    while out.len() < bytes {
        out.push_str(&format!(
            "<Section title=\"Bölüm {i}\" icon='map'>\n  <Stack dir=\"row\" gap=sm>\n    <Text size=\"lg\">**Tonight** — a < b 😀 {{name}}</Text>\n    <Badge tone=\"green\" n={{{i}}} list={{[\"a\", {{\"k\": [1, 2]}}]}}>open</Badge>\n  </Stack>\n  <Code lang=\"ts\">\n    if (a < b) {{ return \"<Tag>\"; }}\n  </Code>\n  <Card of=\"places\" pick=\"p{i}\" meta=\"{{cuisine}} · {{area}}\"/>\n</Section>\n"
        ));
        i += 1;
    }
    out
}

// Cut at a character boundary at or below `at`.
fn head(s: &str, at: usize) -> &str {
    let mut at = at.min(s.len());
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    &s[..at]
}

// Doubling the input may at most triple the time (linear is 2×; the slack is for
// noise), and 64 KB must not take anywhere near a frame even unoptimized.
fn assert_linear(what: &str, input: &dyn Fn(usize) -> String, parse: &dyn Fn(&str)) {
    let (half, full) = (input(32 * KB), input(64 * KB));
    let t_half = best_of(9, || parse(&half));
    let t_full = best_of(9, || parse(&full));
    println!("{what:<44} 32 KB {t_half:>10.1?}   64 KB {t_full:>10.1?}");
    assert!(t_full < Duration::from_millis(400), "{what}: 64 KB took {t_full:?}");
    assert!(
        t_full <= t_half * 3 + Duration::from_micros(300),
        "{what}: 32 KB took {t_half:?}, 64 KB {t_full:?} — not linear"
    );
}

#[test]
#[ignore = "timing: run scripts/perf.sh on a quiet machine"]
fn parsers_stay_linear_on_any_input() {
    let json = present_json(64 * KB);
    let ui = markup(64 * KB);
    assert_linear("parse_partial_json, a present call", &|n| head(&json, n).to_owned(), &|s| {
        parse_partial_json(s, DEFAULT_PARTIAL_KEYS);
    });
    assert_linear("parse_loose_json, the same", &|n| head(&json, n).to_owned(), &|s| {
        let _ = parse_loose_json(s);
    });
    assert_linear("parse_partial, a view", &|n| head(&ui, n).to_owned(), &|s| {
        parse_partial(s);
    });
    assert_linear("parse_markup, a view", &|n| head(&ui, n).to_owned(), &|s| {
        parse_markup(s);
    });

    // Inputs built to make a careless scanner rescan.
    let repeated = |unit: &'static str| move |n: usize| unit.repeat(n / unit.len());
    for unit in [
        "<",
        "<a ",
        "<a>",
        "</a",
        "</a>",
        "<!--",
        "<!-- -->",
        "<T a=\"",
        "<T a={",
        "<T a={[",
        "<Code>",
        "<Code>x</Code",
        "a=\"b\" ",
        "<T a='x' a='y'/>",
        "<a><b></a>",
        "&amp;",
        "\\\"",
        "{",
        "}",
        "\n  ",
    ] {
        assert_linear(&format!("parse_markup, {unit:?} repeated"), &repeated(unit), &|s| {
            parse_markup(s);
        });
        assert_linear(&format!("parse_partial, {unit:?} repeated"), &repeated(unit), &|s| {
            parse_partial(s);
        });
    }
    for unit in [
        "[",
        "{\"a\":",
        "\"",
        "\\",
        "\\u00",
        "[1,",
        "{\"k\":1,",
        "tru",
        "-",
        "1e",
        " ",
        "/*",
        "//\n",
        "9",
        "\"a\":",
        "[[],",
    ] {
        assert_linear(&format!("parse_partial_json, {unit:?} repeated"), &repeated(unit), &|s| {
            parse_partial_json(s, DEFAULT_PARTIAL_KEYS);
        });
        assert_linear(&format!("parse_loose_json, {unit:?} repeated"), &repeated(unit), &|s| {
            let _ = parse_loose_json(s);
        });
    }
    // Keys that are array indexes, arriving in the worst order for a sorted insert.
    let descending = |n: usize| {
        let mut out = String::from("{");
        let mut k = n;
        while out.len() < n {
            out.push_str(&format!("\"{k}\":0,"));
            k -= 1;
        }
        out
    };
    assert_linear("parse_partial_json, descending index keys", &descending, &|s| {
        parse_partial_json(s, DEFAULT_PARTIAL_KEYS);
    });
}

// What a stream costs: the whole input so far is parsed again on every delta.
#[test]
#[ignore = "timing: run scripts/perf.sh on a quiet machine"]
fn a_streamed_present_call_reparsed_on_every_delta() {
    let json = present_json(64 * KB);
    let start = Instant::now();
    let mut parses = 0;
    let mut at = 0;
    while at < json.len() {
        at = (at + KB).min(json.len());
        let prefix = head(&json, at);
        let r = parse_partial_json(prefix, DEFAULT_PARTIAL_KEYS);
        if let Some(Value::String(ui)) = r.value.as_ref().and_then(|v| v.get("ui")) {
            parse_partial(ui);
        }
        parses += 1;
    }
    let elapsed = start.elapsed();
    println!(
        "{parses} deltas of 1 KB up to {} KB: {elapsed:.1?} in all, {:.1?} per delta",
        json.len() / KB,
        elapsed / parses
    );
    assert!(elapsed < Duration::from_secs(5), "a 64 KB stream took {elapsed:?}");
}

#[test]
#[ignore = "timing: run scripts/perf.sh on a quiet machine"]
fn validating_a_full_size_view_is_quick() {
    let json = present_json(88 * KB);
    let input: Value = serde_json::from_str(&json).expect("the sample is valid JSON");
    let took = best_of(5, || {
        validate_view(&input);
    });
    println!("validate_view, {} KB of input: {took:.1?}", json.len() / KB);
    assert!(took < Duration::from_millis(500), "validate_view took {took:?}");

    // Nesting as deep as 24 KB of markup allows: checked without recursion.
    let deep = format!(r#"{{"title":"t","summary":"s","ui":"{}"}}"#, "<Stack>".repeat(24 * KB / 7));
    let input: Value = serde_json::from_str(&deep).expect("valid JSON");
    let took = best_of(3, || {
        validate_view(&input);
    });
    println!("validate_view, {} levels deep: {took:.1?}", 24 * KB / 7);
    assert!(took < Duration::from_millis(500), "a deeply nested view took {took:?}");
}
