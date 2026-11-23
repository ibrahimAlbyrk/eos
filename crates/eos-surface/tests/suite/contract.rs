use eos_surface::{Contract, Type, format_problems, minimal_data, validate};
use serde_json::{Value, json};

fn paper() -> Contract {
    Contract::parse(&json!({"type": "object", "fields": {
        "title": {"type": "text", "max": 20},
        "intro": {"type": "longtext", "max": 400, "required": false, "edit": true},
        "date": {"type": "date"},
        "lead": {"type": "object", "fields": {
            "url": {"type": "url"},
            "image": {"type": "image", "required": false},
            "section": {"type": "enum", "values": ["world", "code"]}}},
        "stories": {"type": "list", "min": 1, "max": 3, "of": {"type": "object", "fields": {
            "title": {"type": "text", "max": 10},
            "score": {"type": "int", "required": false},
            "at": {"type": "datetime", "required": false}}}}}}))
    .expect("the paper's contract is valid")
}

fn problems(contract: &Contract, data: Value) -> String {
    format_problems(&validate(&contract.as_type(), &data).problems)
}

#[test]
fn a_contract_round_trips_through_its_json_form() {
    let contract = paper();
    assert_eq!(Contract::parse(&contract.to_json()).expect("reads back"), contract);
    let intro = &contract.fields[1];
    assert!(!intro.required && intro.edit);
    assert!(contract.fields[0].required && !contract.fields[0].edit);
}

#[test]
fn a_bad_contract_is_refused_with_every_problem_and_its_path() {
    let bad = json!({"type": "object", "fields": {
        "title": {"type": "text"},
        "2nd": {"type": "bool"},
        "kind": {"type": "enum", "values": ["a", "a"]},
        "list": {"type": "list", "of": {"type": "colour"}, "max": 2},
        "range": {"type": "list", "of": {"type": "int"}, "min": 5, "max": 2},
        "flag": {"type": "bool", "required": "yes", "colour": 1},
        "item": {"type": "int"}}});
    let found = format_problems(&Contract::parse(&bad).expect_err("refused"));
    assert_eq!(
        found,
        "fields.title.max: is required: the most characters, at least 1\n\
         fields.2nd: must start with a letter and hold only letters, digits and _\n\
         fields.kind.values: must be a list of different texts, at least one\n\
         fields.list.of.type: colour is not a type\n\
         fields.range.min: is 5, more than max 2\n\
         fields.flag.required: must be true or false\n\
         fields.flag.colour: is not a key of a bool type\n\
         fields.item: is a name Eos fills itself"
    );
    assert!(Contract::parse(&json!({"type": "text", "max": 3})).is_err(), "the top is always an object");
}

#[test]
fn types_nest_only_so_deep() {
    let mut ty = json!({"type": "int"});
    for _ in 0..7 {
        ty = json!({"type": "list", "max": 2, "of": ty});
    }
    let found = format_problems(&Type::parse(&ty).expect_err("too deep"));
    assert!(found.contains("nests deeper than 6 levels"), "{found}");
}

#[test]
fn good_data_passes_and_extra_fields_only_warn() {
    let contract = paper();
    let data = json!({"title": "Morning", "date": "2024-02-29", "surprise": 1,
        "lead": {"url": "https://example.com/a", "section": "code",
                 "image": {"src": "http://img.example/x.png", "alt": "A cat"}},
        "stories": [{"title": "One", "score": 3, "at": "2026-11-24T07:00:00.5+03:00"}]});
    let result = validate(&contract.as_type(), &data);
    assert!(result.is_ok(), "{}", format_problems(&result.problems));
    assert_eq!(format_problems(&result.warnings), "surprise: is not in the contract and is ignored");
}

#[test]
fn bad_data_is_refused_with_every_problem_and_its_path() {
    let found = problems(
        &paper(),
        json!({"title": "A title much too long for it", "date": "2026-02-30",
            "lead": {"url": "javascript:alert(1)", "section": "sport", "image": {"src": "file:///etc/passwd"}},
            "stories": [{"title": "Two\nlines", "score": 1.5, "at": "yesterday"}, {}, {"title": 3}, {"title": "x"}]}),
    );
    assert_eq!(
        found,
        "title: is 28 characters, max 20\n\
         date: must be a date like 2026-11-24\n\
         lead.url: must be an http or https address\n\
         lead.image.src: must be an http or https address\n\
         lead.image.alt: is required\n\
         lead.section: must be one of world, code\n\
         stories: has 4 items, max 3\n\
         stories[0].title: must be one line\n\
         stories[0].score: must be a whole number\n\
         stories[0].at: must be a date and time like 2026-11-24T07:00:00Z\n\
         stories[1].title: is required\n\
         stories[2].title: must be text"
    );
    assert_eq!(problems(&paper(), json!([])), "must be an object");
}

#[test]
fn minimal_data_keeps_lists_at_their_minimum_and_leaves_optionals_out() {
    let contract = paper();
    let data = minimal_data(&contract.fields);
    assert!(validate(&contract.as_type(), &data).is_ok());
    assert_eq!(data["stories"].as_array().map(Vec::len), Some(1));
    assert!(data.get("intro").is_none());
    assert!(data["lead"].get("image").is_none());
    assert!(data["stories"][0].get("score").is_none());
}
