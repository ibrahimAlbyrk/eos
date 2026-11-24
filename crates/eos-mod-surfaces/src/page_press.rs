//! A press on a Page issue's Button or Ask, read from the design of the
//! version the issue was made with: the part names the component, its
//! template names the action and its argument template, and the repeat it
//! sits in names the list whose row the press's index or id picks. The frame
//! names only the part and the row; every value comes from the stored issue.

use eos_surface::{PageDesign, Sources, fill_args, pressed_row};
use serde_json::{Value, json};

/// The action an Ask runs: it hands the row it sits in to the routine's agent.
pub(crate) const ASK_ACTION: &str = "surface.ask";

/// The action id and filled arguments a press of `part` means, or why it
/// means nothing.
pub(crate) fn resolve(
    design: &PageDesign,
    data: &Value,
    issue_id: &str,
    part: &str,
    item_id: Option<&str>,
    index: Option<u32>,
    state: &Value,
) -> Result<(String, Value), String> {
    let Some(pressable) = design.template.pressable(part) else { return Err("That issue has no such button".into()) };
    if pressable.nested {
        return Err("That button sits in a list inside a list, which a press cannot name".into());
    }
    let mut fields = data.clone();
    let item = match &pressable.row {
        Some(row) => {
            let Some(found) = pressed_row(data, &format!("data.{}", row.list), item_id, index) else {
                return Err("That button needs the row it was pressed on".into());
            };
            if let Value::Object(map) = &mut fields {
                map.insert(row.name.clone(), found.clone());
            }
            found.clone()
        }
        None => Value::Null,
    };
    match pressable.action {
        Some(action) => {
            let from = Sources { data, state, item: &item, fields: &fields };
            Ok((action, fill_args(&pressable.args, from)))
        }
        None => {
            let mut args = json!({ "issue": issue_id, "part": part });
            if !item.is_null() {
                args["item"] = json!(item.to_string());
            }
            Ok((ASK_ACTION.to_owned(), args))
        }
    }
}
