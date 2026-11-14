//! A Claude transcript as conversation rows, against the TypeScript: every
//! session in `tests/fixtures/claude-transcript-vectors.json` (frozen from the TypeScript, see `fixtures/README.md`)
//! must give the rows the TypeScript gave.

use eos_domain::claude_transcript::TranscriptRows;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Fixture {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    lines: String,
    #[serde(default)]
    tail: String,
    #[serde(default)]
    sidechain: bool,
    view: Value,
}

#[test]
fn a_transcript_reads_as_the_typescript_reads_it() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/claude-transcript-vectors.json")).expect("vectors");
    assert!(fixture.vectors.len() >= 15);
    for vector in fixture.vectors {
        let mut rows = TranscriptRows::new(vector.sidechain);
        rows.add(&vector.lines);
        let view = rows.view(&vector.tail);
        let got = json!({ "rows": view.rows, "running": view.running, "pending": view.pending });
        assert_eq!(got, vector.view, "{}", vector.name);
        // Field order is part of the wire.
        assert_eq!(got.to_string(), vector.view.to_string(), "{} (as text)", vector.name);
    }
}
