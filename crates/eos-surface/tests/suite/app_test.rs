//! The document an App is tested in: Eos's host outside, the App in a frame
//! sandboxed to scripts alone under the dashboard's policy, Eos's harness
//! before the App and the builder's tests after it, none able to end its
//! script element early.

use eos_surface::{APP_CSP, APP_TEST_CSP, APP_TEST_JS, AppDesign, app_test_document};
use serde_json::json;

fn design(html: &str, tests: Option<&str>) -> AppDesign {
    let body = json!({
        "html": html,
        "manifest": {"title": "Counter", "summary": "Counts.", "uses": [], "queries": ["surface.issues"],
                     "files": {"root": "routine_files", "read": ["notes/*.md"]}},
        "tests": tests,
    });
    AppDesign::from_body(&body, |_| false).expect("an App")
}

/// The frame's document, as the srcdoc attribute holds it.
fn frame_of(doc: &str) -> String {
    let start = doc.find("srcdoc=\"").expect("a frame") + 8;
    let end = start + doc[start..].find('"').expect("closed");
    doc[start..end].replace("&quot;", "\"").replace("&amp;", "&")
}

#[test]
fn the_app_runs_in_a_sandboxed_frame_after_eos_harness_and_before_its_tests() {
    let doc = app_test_document(&design(
        "<p id=\"n\">0 &amp; more</p><script>n.textContent = \"1\";</script>",
        Some("eosTest.expect(eosTest.text('#n') === '1', 'counts');"),
    ));
    assert_eq!(APP_TEST_JS, "window.__eosAppTests");
    assert_eq!(APP_TEST_CSP, APP_CSP);
    assert!(APP_CSP.contains("connect-src 'none'") && APP_CSP.starts_with("default-src 'none'"));
    assert!(doc.contains("<iframe id=\"eos-app\" sandbox=\"allow-scripts\" csp=\""));
    assert!(!doc.contains("allow-same-origin"));
    let host_at = doc.find("data-eos-host").expect("the host");
    assert!(host_at < doc.find("<iframe").expect("the frame"), "the host listens before the frame loads");
    assert!(doc.contains(r#""queries":["surface.issues"]"#) && doc.contains(r#""filesRead":true"#));
    assert!(doc.contains(r#""filesWrite":false"#));

    let frame = frame_of(&doc);
    let (policy, harness, app, tests) = (
        frame.find("Content-Security-Policy").expect("the policy"),
        frame.find("data-eos-harness").expect("the harness"),
        frame.find("<p id=\"n\">0 &amp; more</p>").expect("the App as written"),
        frame.find("data-eos-tests").expect("the tests"),
    );
    assert!(policy < harness && harness < app && app < tests);
}

#[test]
fn neither_tests_nor_manifest_end_their_script_early() {
    let doc = app_test_document(&design("<p>hi</p>", Some("const s = '</SCRIPT><img src=x>';")));
    let frame = frame_of(&doc);
    assert!(frame.contains(r"const s = '<\/SCRIPT><img src=x>';"), "{frame}");
    assert_eq!(frame.matches("</script>").count(), 2, "the harness's and the tests' own");
    let without = frame_of(&app_test_document(&design("<p>hi</p>", None)));
    assert!(!without.contains("data-eos-tests"));
}
