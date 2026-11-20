use eos_contracts::{Part, ResultDoc};
use serde_json::{Value, json};

use super::*;

fn note(n: usize) -> String {
    format!("n:{n}")
}

/// A small kind with a choice, a required text and numbered notes.
fn shape() -> ResultShape {
    let part = |key, role: &str, name: &str, required, values: &[&str], example: &str| PartShape {
        key,
        role: role.into(),
        name: name.into(),
        required,
        what: format!("The {name}."),
        values: values.iter().map(|value| (*value).to_owned()).collect(),
        meta: Vec::new(),
        otherwise: None,
        example: example.into(),
    };
    let mut each = part(PartKey::Each(note), "note", "note", false, &[], "Look here.");
    each.meta = vec![
        MetaShape {
            name: "at".into(),
            required: true,
            value: MetaValue::Line,
            what: "Where.".into(),
            example: json!(3),
        },
        MetaShape {
            name: "side".into(),
            required: false,
            value: MetaValue::OneOf(vec!["L".into(), "R".into()]),
            what: "Which side.".into(),
            example: json!("R"),
        },
    ];
    each.otherwise = Some("put the rest in the top part".into());
    ResultShape {
        kind: "x.note".into(),
        channel: "x".into(),
        actions: vec!["post".into(), "approve".into()],
        parts: vec![
            part(PartKey::One("mood".into()), "mood", "mood", false, &["GOOD", "BAD"], "GOOD"),
            part(PartKey::One("top".into()), "summary", "top part", true, &[], "All fine."),
            each,
        ],
        notes: vec!["A remark with no place goes in the top part.".into()],
    }
}

fn part(key: &str, text: &str, meta: Value) -> Part {
    Part {
        key: key.into(),
        role: "note".into(),
        text: text.into(),
        meta: meta.as_object().cloned().unwrap_or_default(),
    }
}

fn doc(parts: Vec<Part>) -> ResultDoc {
    ResultDoc { kind: "x.note".into(), channel: "x".into(), action: "post".into(), parts }
}

#[test]
fn the_example_in_the_text_is_one_the_check_takes() {
    let text = shape().describe();
    let json = text.split("```json\n").nth(1).and_then(|rest| rest.split("\n```").next()).expect("an example");
    let example: ResultDoc = serde_json::from_str(json).expect("a result");
    assert_eq!(shape().check(&example), Vec::<String>::new());
    assert_eq!(example.parts.iter().map(|part| part.key.as_str()).collect::<Vec<_>>(), ["mood", "top", "n:1"]);
    for told in
        ["kind `x.note`", "one of `post`, `approve`", "`n:1`, `n:2`, … (each other part)", "`meta.at`, required"]
    {
        assert!(text.contains(told), "{told} in {text}");
    }
    assert!(text.contains("One of `L`, `R`."), "{text}");
    assert!(text.contains("A remark with no place goes in the top part."), "{text}");
}

#[test]
fn each_misfit_names_the_part_what_is_wrong_and_what_is_expected() {
    let shape = shape();
    let top = part("top", "Fine.", json!({}));
    assert_eq!(shape.check(&doc(vec![top.clone(), part("n:1", "x", json!({"at": 2}))])), Vec::<String>::new());

    let found = shape.check(&doc(vec![top.clone(), part("body", "General words.", json!({}))]));
    assert_eq!(found, ["part `body`: a note needs meta.at; put the rest in the top part."]);

    let found = shape.check(&doc(vec![
        part("mood", "MAYBE", json!({})),
        part("n:1", "x", json!({"at": 0, "side": "UP"})),
        part("n:1", "y", json!({"at": 1})),
    ]));
    assert_eq!(
        found,
        [
            "part `n:1`: two parts have this key; give each part its own key.",
            "part `top` is missing: The top part.",
            "part `mood`: its text must be one of `GOOD`, `BAD`.",
            "part `n:1`: meta.at must be a line number, a whole number from 1.",
            "part `n:1`: meta.side must be one of `L`, `R`.",
        ]
    );

    let wrong = ResultDoc { kind: "note".into(), channel: "y".into(), action: "send".into(), parts: vec![top.clone()] };
    assert_eq!(
        shape.check(&wrong),
        [
            "body `kind` is `note`: it must be `x.note`.",
            "`channel` is `y`: a x.note goes through `x`.",
            "`action` is `send`: it must be one of `post`, `approve`.",
        ]
    );
    let bare = ResultDoc { kind: "x.note".into(), channel: String::new(), action: String::new(), parts: vec![top] };
    assert_eq!(shape.check(&bare).len(), 1, "one line says the whole object is missing");
}
