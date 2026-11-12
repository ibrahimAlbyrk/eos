//! The pure rules of the browser against what today's TypeScript computes
//! (`rust/fixtures/browser/vectors.json`, written by `rust/tools/browser-vectors`).

use std::path::PathBuf;

use eos_mod_browser::{
    Actor, FormatOptions, check_navigation, format_ax_tree, parse_chord, profile_key, redact_for_agent, redact_headers,
    role_of, states_of,
};
use serde_json::{Value, json};

fn vectors() -> Value {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/browser/vectors.json"));
    serde_json::from_slice(&std::fs::read(&path).expect("the vectors file")).expect("vectors are JSON")
}

fn list<'a>(vectors: &'a Value, key: &str) -> &'a Vec<Value> {
    vectors.pointer(key).and_then(Value::as_array).unwrap_or_else(|| panic!("{key} is a list"))
}

#[test]
fn snapshots_render_as_the_typescript_formatter_renders_them() {
    let vectors = vectors();
    let cases = list(&vectors, "/ax");
    assert!(cases.len() > 250);
    for (i, case) in cases.iter().enumerate() {
        let options = FormatOptions {
            interactive_only: case["options"]["interactiveOnly"].as_bool().expect("interactiveOnly"),
            depth: case["options"].get("depth").and_then(Value::as_u64),
            root_backend_node_id: case["options"].get("rootBackendNodeId").and_then(Value::as_i64),
            ref_start: case["options"]["refStart"].as_u64().expect("refStart") as u32,
        };
        let nodes = case["nodes"].as_array().expect("nodes");
        let got = format_ax_tree(nodes, options);
        assert_eq!(got.text, case["text"].as_str().expect("text"), "tree {i}: {options:?}");
        let refs: Vec<Value> = got.refs.iter().map(|(name, backend)| json!([name, backend])).collect();
        assert_eq!(Value::Array(refs), case["refs"], "tree {i}: refs");
        assert_eq!(u64::from(got.next_ref_index), case["nextRefIndex"].as_u64().expect("nextRefIndex"), "tree {i}");
    }
}

#[test]
fn roles_and_states_read_as_in_typescript() {
    let vectors = vectors();
    for fact in list(&vectors, "/nodes") {
        let node = &fact["node"];
        assert_eq!(role_of(node), fact["role"].as_str().expect("role"), "{node}");
        assert_eq!(json!(states_of(node)), fact["states"], "{node}");
    }
}

#[test]
fn key_chords_parse_as_in_typescript() {
    let vectors = vectors();
    let chords = list(&vectors, "/chords");
    assert!(chords.len() > 50);
    for case in chords {
        let chord = case["chord"].as_str().expect("chord");
        match (parse_chord(chord), case.get("ok"), case.get("error")) {
            (Ok(got), Some(want), _) => {
                let got = json!({
                    "modifiers": got.modifiers,
                    "key": got.key,
                    "code": got.code,
                    "windowsVirtualKeyCode": got.windows_virtual_key_code,
                    "text": got.text,
                });
                assert_eq!(&got, want, "{chord:?}");
            }
            (Err(got), _, Some(want)) => assert_eq!(got, want.as_str().expect("error"), "{chord:?}"),
            (got, _, _) => panic!("{chord:?}: got {got:?}, the TypeScript answered {case}"),
        }
    }
}

#[test]
fn the_origin_allowlist_decides_as_in_typescript() {
    let vectors = vectors();
    let cases = list(&vectors, "/navigation");
    assert!(cases.len() > 400);
    for case in cases {
        let allowed: Vec<String> = case["allowed"]
            .as_array()
            .expect("allowed")
            .iter()
            .map(|e| e.as_str().expect("entry").to_owned())
            .collect();
        let url = case["url"].as_str().expect("url");
        let actor = if case["actor"] == "human" { Actor::Human } else { Actor::Agent };
        let got = check_navigation(url, actor, &allowed).err();
        assert_eq!(got.as_deref(), case["error"].as_str(), "{url:?} for {actor:?} with {allowed:?}");
    }
}

#[test]
fn redaction_is_the_typescript_redaction() {
    let vectors = vectors();
    for case in list(&vectors, "/redaction/headers") {
        let headers = case["headers"].as_object().expect("headers");
        assert_eq!(Value::Object(redact_headers(headers)), case["redacted"], "{}", case["headers"]);
    }
    for case in list(&vectors, "/redaction/payloads") {
        assert_eq!(redact_for_agent(case["payload"].clone()), case["redacted"], "{}", case["payload"]);
    }
}

#[test]
fn session_keys_become_the_same_folder_names() {
    let vectors = vectors();
    for case in list(&vectors, "/profiles") {
        let session = case["session"].as_str().expect("session");
        assert_eq!(profile_key(session), case["folder"].as_str().expect("folder"), "{session:?}");
    }
}
