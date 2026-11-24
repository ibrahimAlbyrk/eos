//! The architect's tools: its own list, and each call handed to the
//! routines feature.

use eos_core::agent::{LaunchSpec, ToolSets};
use eos_testkit::FakeFeatures;
use serde_json::json;

use crate::tests::{bench, call, run_session, session_of};

/// Keyed on its reserved definition, whatever kind of session it is: its
/// own tools, `list_capabilities` alone and `list_routines`.
#[test]
fn an_architect_gets_its_own_list() {
    let bench = bench(FakeFeatures::new([]));
    let own = ["get_routine", "propose_blueprint", "ask_choice", "find_past_items", "start_trial", "list_capabilities"];
    let own = [own.as_slice(), &["list_routines"]].concat();
    assert_eq!(bench.names("architect"), own, "it never calls a capability itself");
    let as_worker = LaunchSpec { worker_definition: Some("eos-architect".into()), ..session_of("peer") };
    let names: Vec<String> = bench.tools.for_session(&as_worker).iter().map(|t| t.definition().name.clone()).collect();
    assert_eq!(names, own, "the definition decides, not the role");
    for kind in ["orchestrator", "focused-peer", "run-lead", "run-checker"] {
        assert!(!bench.names(kind).iter().any(|name| name == "propose_blueprint"), "{kind}");
    }
    assert_eq!(run_session("eos-architect").worker_definition.as_deref(), Some("eos-architect"));
}

#[tokio::test]
async fn the_architect_tools_hand_the_call_to_the_routines_feature() {
    let bench = bench(FakeFeatures::new([]));
    let tool = |name: &str| bench.tool("architect", name);
    let read = call(&tool("get_routine"), "w-arch", json!({})).await;
    assert_eq!((read.text.as_str(), read.is_error), ("{\n  \"name\": \"PR Review\"\n}", false));
    let drafted =
        call(&tool("propose_blueprint"), "w-arch", json!({"blueprint": {"name": "PR Review"}, "note": "First."})).await;
    assert_eq!(drafted.text, "Draft written, with warnings:\n- summary: Required");
    let refused = call(&tool("propose_blueprint"), "w-arch", json!({"blueprint": {}})).await;
    assert_eq!(
        (refused.text.as_str(), refused.is_error),
        ("Not written. Fix these and propose again:\n- name: Required", false),
        "only the errors block"
    );
    let asked =
        call(&tool("ask_choice"), "w-arch", json!({"question": "Which repo?", "choices": ["game", "web"]})).await;
    assert!(!asked.is_error && asked.ends_turn, "the answer comes as the next message");
    let past = call(&tool("find_past_items"), "w-arch", json!({})).await;
    assert_eq!(past.text, "No past items: a trial is one run without an item.");
    let tried = call(&tool("start_trial"), "w-arch", json!({})).await;
    assert_eq!(tried.text, "2 trial run(s) started. You hear how each ends.");
    assert_eq!(
        *bench.runs.0.lock().expect("calls"),
        [
            "get w-arch",
            r#"propose w-arch {"name":"PR Review"} Some("First.")"#,
            "propose w-arch {} None",
            r#"ask w-arch Which repo? ["game", "web"]"#,
            "past w-arch 10",
            "trial w-arch",
        ]
    );
    let nobody = call(&tool("start_trial"), "w-none", json!({})).await;
    assert!(nobody.is_error, "{}", nobody.text);
}
