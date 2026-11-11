//! `policy.yaml` on disk: read as the `yaml` package reads it, written as it
//! writes it. The texts and what they parse to come from the TypeScript
//! (`rust/fixtures/policy/decisions.json`).

use std::path::PathBuf;

use eos_core::policy::{PolicyDocument, PolicyFile};
use eos_store_files::policy::{BUNDLED_POLICY, YamlPolicyFile};
use eos_testkit::TempHome;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct PolicyCase {
    text: String,
    parses: bool,
    doc: Value,
}

#[derive(Deserialize)]
struct Corpus {
    policies: Vec<PolicyCase>,
}

fn repo_file(relative: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(relative)
}

#[test]
fn policy_files_parse_to_what_typescript_parses_them_to() {
    let text = std::fs::read_to_string(repo_file("rust/fixtures/policy/decisions.json")).expect("the corpus");
    let corpus: Corpus = serde_json::from_str(&text).expect("the corpus");
    assert!(corpus.policies.len() >= 14);
    let home = TempHome::new();
    for (i, case) in corpus.policies.iter().enumerate() {
        let path = home.write("policy.yaml", &case.text);
        match YamlPolicyFile::new(path).load() {
            PolicyDocument::Parsed { value, .. } => {
                assert!(case.parses, "#{i} parses here, not in TypeScript");
                assert_eq!(value, case.doc, "#{i}");
            }
            PolicyDocument::Unreadable { .. } => assert!(!case.parses, "#{i} parses in TypeScript, not here"),
            PolicyDocument::Missing => panic!("#{i}: the file is there"),
        }
    }
}

#[test]
fn without_a_users_file_the_bundled_policy_is_in_force() {
    let home = TempHome::new();
    let file = YamlPolicyFile::new(home.join("policy.yaml"));
    let PolicyDocument::Parsed { value, source } = file.load() else { panic!("the bundled policy parses") };
    assert_eq!(source, "policy.example.yaml (bundled)");
    assert_eq!(value["default"], "allow");
    assert_eq!(value["rules"].as_array().map(Vec::len), Some(18));
    assert_eq!(file.read_user().expect("reads"), None);

    // The bundled copy is the TypeScript tree's file, while that tree exists.
    if let Ok(theirs) = std::fs::read_to_string(repo_file("manager/policy.example.yaml")) {
        assert_eq!(BUNDLED_POLICY, theirs);
    }
}

#[test]
fn a_saved_document_is_written_as_the_yaml_package_writes_it() {
    let home = TempHome::new();
    let file = YamlPolicyFile::new(home.join("policy.yaml"));
    let document = json!({
        "default": "ask",
        "ttlMs": 3000,
        "rules": [
            {"tool": "Bash", "command": "rm\\s+-rf", "action": "deny", "reason": "destructive command blocked"},
            {"tool": "WebFetch", "action": "allow"},
        ],
    });
    file.write_user(&document).expect("writes");
    assert_eq!(
        home.read("policy.yaml"),
        "default: ask\nttlMs: 3000\nrules:\n  - tool: Bash\n    command: rm\\s+-rf\n    action: deny\n    reason: destructive command blocked\n  - tool: WebFetch\n    action: allow\n"
    );
    assert_eq!(file.read_user().expect("reads"), Some(document.clone()));
    assert_eq!(
        file.load(),
        PolicyDocument::Parsed { source: home.join("policy.yaml").display().to_string(), value: document }
    );
}

#[test]
fn a_users_file_that_does_not_parse_is_reported_not_replaced() {
    let home = TempHome::new();
    let file = YamlPolicyFile::new(home.write("policy.yaml", "default: [unclosed\n"));
    assert!(matches!(file.load(), PolicyDocument::Unreadable { .. }));
    assert!(file.read_user().is_err());
    let empty = YamlPolicyFile::new(home.write("empty.yaml", ""));
    assert_eq!(empty.read_user().expect("reads"), None);
}
