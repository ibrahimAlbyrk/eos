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
    let filled = eos_surface::fill_args(template.as_object().expect("an object"), &data, &state);
    assert_eq!(
        filled,
        json!({"item": "https://example.com/a", "rev": 2, "note": "About Invoice: call back",
               "list": ["b", 3], "plain": "no slots", "missing": null})
    );
}
