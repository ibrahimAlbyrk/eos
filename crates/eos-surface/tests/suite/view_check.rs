use eos_surface::{format_problems, view_check};
use serde_json::{Value, json};

fn view(actions: Value) -> Value {
    json!({"title": "Digest", "summary": "Three mails", "ui": "<Text>Hi</Text>", "actions": actions})
}

fn known(id: &str) -> bool {
    id.starts_with("routine.")
}

#[test]
fn every_send_is_bound_to_a_declared_action_with_a_template() {
    let v = view(json!({
        "again": {"label": "Run again", "kind": "send", "text": "again"},
        "with": {"label": "Dig deeper", "kind": "send", "text": "x"},
        "site": {"label": "Open", "kind": "open", "href": "https://example.com"}}));
    let bindings = json!({
        "again": {"action": "routine.run_again"},
        "with": {"action": "routine.run_with", "args": {"item": "{data.lead.url}", "note": ["{state.note}"]}}});
    let found = view_check(&v, Some(&bindings), known).expect("bound");
    assert_eq!(found.len(), 2);
    assert_eq!(found[1].action, "routine.run_with");
    assert_eq!(found[1].args["item"], "{data.lead.url}");
    assert!(found[0].args.is_empty());
}

#[test]
fn prefill_unbound_sends_and_bad_bindings_are_refused() {
    let v = view(json!({
        "fill": {"label": "Fill", "kind": "prefill", "text": "x"},
        "loose": {"label": "Go", "kind": "send", "text": "x"},
        "bad": {"label": "Bad", "kind": "send", "text": "x"},
        "slot": {"label": "Slot", "kind": "send", "text": "x"},
        "copy": {"label": "Copy", "kind": "copy", "text": "x"}}));
    let bindings = json!({
        "bad": {"action": "mail.send_anything", "to": "x"},
        "slot": {"action": "routine.run_with", "args": {"to": "{secret.key}", "list": [1, "{data.}"]}},
        "copy": {"action": "routine.run_again"},
        "ghost": {"action": "routine.run_again"}});
    let found = format_problems(&view_check(&v, Some(&bindings), known).expect_err("refused"));
    assert_eq!(
        found,
        "view.actions.fill.kind: prefill has no chat to write into outside a chat; bind a send instead\n\
         view.actions.loose: is a send with no entry in bindings; name the action it runs\n\
         bindings.bad.to: is not a binding field\n\
         bindings.bad.action: mail.send_anything is not an action this routine may run\n\
         bindings.slot.args.to: {secret.key} must name data.<path> or state.<key>\n\
         bindings.slot.args.list[1]: {data.} must name data.<path> or state.<key>\n\
         bindings.copy: binds no send action of the view\n\
         bindings.ghost: binds no send action of the view"
    );
    assert!(view_check(&v, Some(&json!([])), known).is_err());
    assert!(view_check(&view(json!({})), None, known).expect("nothing to bind").is_empty());
}

#[test]
fn argument_templates_fill_from_the_stored_data_and_the_users_input_only() {
    let template = json!({
        "item": "{data.lead.url}", "rev": "{data.rev}", "note": "About {data.lead.title}: {state.note}{data.gone}",
        "list": ["{data.items.1}", 3], "plain": "no slots", "missing": "{data.nowhere}"});
    let data = json!({"lead": {"url": "https://example.com/a", "title": "Invoice"}, "rev": 2, "items": ["a", "b"]});
    let state = json!({"note": "call back"});
    let from = eos_surface::Sources { data: &data, state: &state, item: &Value::Null };
    let filled = eos_surface::fill_args(template.as_object().expect("an object"), from);
    assert_eq!(
        filled,
        json!({"item": "https://example.com/a", "rev": 2, "note": "About Invoice: call back",
               "list": ["b", 3], "plain": "no slots", "missing": null})
    );
}

#[test]
fn a_button_in_a_lists_rows_binds_the_row_it_was_pressed_on() {
    let v = view(json!({"open": {"label": "Open", "kind": "send", "text": "open"}}));
    let known = |id: &str| id == "routine.run_on";
    let bound = json!({"open": {"action": "routine.run_on", "list": "data.stories", "args": {"item": "{item.url}"}}});
    let bindings = view_check(&v, Some(&bound), known).expect("bound");
    assert_eq!(bindings[0].list.as_deref(), Some("data.stories"));
    let rowless = json!({"open": {"action": "routine.run_on", "args": {"item": "{item.url}"}}});
    let found = format_problems(&view_check(&v, Some(&rowless), known).expect_err("refused"));
    assert_eq!(found, "bindings.open.args.item: {item.url} names a row: give the binding the list its button sits in");
    let outside = json!({"open": {"action": "routine.run_on", "list": "state.rows", "args": {}}});
    assert!(view_check(&v, Some(&outside), known).is_err(), "a list is the issue's own data");

    let data = json!({"stories": [{"id": "s-1", "url": "https://a.example"}, {"id": 7, "url": "https://b.example"}]});
    let row = |id, index| eos_surface::pressed_row(&data, "data.stories", id, index).map(|row| row["url"].clone());
    assert_eq!(row(Some("7"), None), Some(json!("https://b.example")), "by its id");
    assert_eq!(row(None, Some(0)), Some(json!("https://a.example")), "by its index");
    assert_eq!(row(Some("s-9"), Some(0)), None, "an id that names no row is no row");
    assert_eq!(row(None, Some(5)), None);
    let pressed = eos_surface::pressed_row(&data, "data.stories", None, Some(1)).expect("a row");
    let from = eos_surface::Sources { data: &data, state: &json!({}), item: pressed };
    let template = json!({"item": "{item.url}", "about": "Story {item.id}"});
    let filled = eos_surface::fill_args(template.as_object().expect("an object"), from);
    assert_eq!(filled, json!({"item": "https://b.example", "about": "Story 7"}));
}
