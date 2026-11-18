use eos_contracts::{Part, ResultDoc};
use serde_json::{Map, Value};

use super::*;

const VECTORS: &str = include_str!("../../tests/fixtures/outbound-vectors.json");

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("a list").iter().map(|item| item.as_str().expect("a string").to_owned()).collect()
}

fn max_bytes(value: &Value) -> usize {
    usize::try_from(value.as_u64().expect("a size")).expect("fits")
}

#[test]
fn every_vector_earns_its_flags() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("the vectors are JSON");
    let given = &vectors["context"];
    let mut context = OutboundContext::new(max_bytes(&given["maxBytes"]));
    context.hosts = strings(&given["hosts"]);
    context.handles = strings(&given["handles"]);
    context.addresses = strings(&given["addresses"]);
    context.numbers = strings(&given["numbers"]);
    for text in strings(&given["from"]) {
        context.add_from(&text);
    }
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() > 30, "{} cases", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("a name");
        let parts = strings(&case["parts"])
            .into_iter()
            .enumerate()
            .map(|(n, text)| Part { key: format!("p:{n}"), role: "paragraph".into(), text, meta: Map::new() })
            .collect();
        let doc = ResultDoc { kind: "text".into(), channel: "github".into(), action: "post_review".into(), parts };
        let mut checked = context.clone();
        if let Some(limit) = case.get("maxBytes") {
            checked.max_bytes = max_bytes(limit);
        }
        let flags: Vec<&str> = check(&doc, &checked).into_iter().map(Flag::as_str).collect();
        assert_eq!(flags, strings(&case["flags"]), "{name}");
    }
}

#[test]
fn the_context_takes_in_what_a_text_names() {
    let mut context = OutboundContext::new(100);
    context.add_from("PR https://GitHub.com/acme/game by @OctoCat, mail bob@Example.org or +44 20 7946 0958");
    assert_eq!(context.hosts, ["github.com"]);
    assert_eq!(context.handles, ["octocat"]);
    assert_eq!(context.addresses, ["bob@example.org"]);
    assert_eq!(context.numbers, ["442079460958"]);
}

#[test]
fn flags_have_their_names() {
    let names: Vec<&str> =
        [Flag::NewHost, Flag::Image, Flag::NewMention, Flag::NewAddress, Flag::SecretLike, Flag::TooLong]
            .into_iter()
            .map(Flag::as_str)
            .collect();
    assert_eq!(names, ["new_host", "image", "new_mention", "new_address", "secret_like", "too_long"]);
}
