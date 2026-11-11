//! The kept vector: `JsRegex` (regress, flagless, over UTF-16 code units) must
//! agree with Node on every probe — which patterns are SyntaxErrors, where each
//! match starts, what it and its groups contain, and what `replace` returns.
//! fixtures/regex is written by ts/regex-probes.ts + ts/regex-expected.ts.

use std::{fs, path::PathBuf};

use spike_jsregex::{
    JsRegex,
    compare::{Cases, parse_expected, run},
    engines::RegressUcs2,
};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/regex")
}

#[test]
fn every_probe_behaves_as_in_node() {
    let cases: Cases = serde_json::from_slice(&fs::read(fixtures().join("probes.json")).unwrap()).unwrap();
    let expected = parse_expected(&fs::read_to_string(fixtures().join("expected.json")).unwrap()).unwrap();
    let inputs = cases.inputs.clone().unwrap();
    assert!(cases.patterns.len() >= 70 && inputs.len() >= 80);
    let rep = run(&RegressUcs2, &cases.patterns, &expected, &inputs);
    assert!(rep.notes.is_empty(), "differences:\n{}", rep.notes.join("\n"));
    assert_eq!(rep.identical, rep.patterns);
    assert_eq!(rep.inputs_identical, rep.inputs_compared);
}

#[test]
fn the_shipped_policy_rules_decide_as_documented() {
    let deny_root = JsRegex::new(r"^\s*rm\s+-[rRf]+\s+/(\s|$)").unwrap();
    assert!(deny_root.test("rm -rf /"));
    assert!(!deny_root.test("rm -rf /tmp/x"));

    let eos = JsRegex::new(r"rm\s+-[rRf]+\s+[~/]?[^\s]*\.eos(?!/scratch/[^\s/]+/)").unwrap();
    assert!(eos.test("rm -rf ~/.eos"));
    assert!(!eos.test("rm -rf ~/.eos/scratch/abc/build"));

    let needs_timeout = JsRegex::new(r"(^|\s)curl(?!.*--max-time)").unwrap();
    let rewrite = JsRegex::new(r"(^|\s)curl\b").unwrap();
    assert!(needs_timeout.test("time curl -s x"));
    assert!(!needs_timeout.test("curl --max-time 5 x"));
    assert_eq!(rewrite.replace("time curl -s x", "$1curl --max-time 10"), "time curl --max-time 10 -s x");
}

#[test]
fn what_javascript_rejects_is_rejected() {
    for bad in ["(?i)rm", "*.ts", "src/**/*.ts", "(", "a++", "(?>a+)b", "[z-a]"] {
        assert!(JsRegex::new(bad).is_err(), "{bad}");
    }
}
