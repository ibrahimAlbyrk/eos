//! The screen mirror against today's: every session in
//! `tests/fixtures/mirror-vectors.json` was run through
//! `manager/services/pty/screenMirror.ts` (frozen from the TypeScript, see `rust/fixtures/README.md`), and each
//! snapshot here must be that text exactly.

use eos_pty::Screen;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    vectors: Vec<Session>,
}

#[derive(Deserialize)]
struct Session {
    name: String,
    cols: u16,
    rows: u16,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Step {
    Write(String),
    Resize([u16; 2]),
    Snapshot(String),
}

/// Where two texts first differ, with some context, escapes made visible.
fn first_difference(expected: &str, got: &str) -> String {
    let at = expected.bytes().zip(got.bytes()).position(|(a, b)| a != b).unwrap_or(expected.len().min(got.len()));
    let window = |s: &str| {
        let from = (0..=at.saturating_sub(40)).rev().find(|i| s.is_char_boundary(*i)).unwrap_or(0);
        let to = (at + 60).min(s.len());
        let to = (to..=s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
        format!("{:?}", &s[from..to])
    };
    format!("at byte {at}\n  expected {}\n  got      {}", window(expected), window(got))
}

#[test]
fn snapshots_equal_todays_mirror() {
    let path = std::env::var("EOS_MIRROR_VECTORS")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mirror-vectors.json").to_owned());
    let text = std::fs::read_to_string(&path).expect("the vectors file");
    let fixture: Fixture = serde_json::from_str(&text).expect("vectors");
    assert!(!fixture.vectors.is_empty());

    let mut failures = Vec::new();
    let mut snapshots = 0;
    for session in &fixture.vectors {
        let mut screen = Screen::new(session.cols, session.rows);
        for (i, step) in session.steps.iter().enumerate() {
            match step {
                Step::Write(data) => screen.write(data),
                Step::Resize([cols, rows]) => screen.resize(*cols, *rows),
                Step::Snapshot(expected) => {
                    snapshots += 1;
                    let got = screen.snapshot();
                    if got != *expected {
                        failures.push(format!("{} (step {i}): {}", session.name, first_difference(expected, &got)));
                        break;
                    }
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} sessions differ ({snapshots} snapshots compared):\n{}",
        failures.len(),
        fixture.vectors.len(),
        failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}
