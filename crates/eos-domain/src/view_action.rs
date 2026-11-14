//! A click in a visual answer, as the turn the agent reads.

use eos_contracts::{UserMessageAction, ViewAction};
use serde_json::{Map, Value};

pub const VIEW_ACTION_PREFIX: &str = "[view action]";

/// The turn a view action becomes.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewActionTurn {
    /// What the agent reads: the label, what the user typed beside it, and
    /// one line of JSON with the view, the action, the item and the state.
    pub text: String,
    /// What the chat shows.
    pub display_text: String,
    /// What the chat's reply chip is drawn from.
    pub action: UserMessageAction,
}

pub fn view_action_turn(action: &ViewAction, said: Option<&str>) -> ViewActionTurn {
    let label = Some(action.label.trim()).filter(|l| !l.is_empty()).unwrap_or(&action.action_id).to_owned();
    let mut payload = Map::new();
    payload.insert("viewId".into(), serde_json::to_value(&action.view_id).unwrap_or_default());
    payload.insert("actionId".into(), action.action_id.clone().into());
    if let Some(item) = &action.item {
        payload.insert("item".into(), serde_json::to_value(item).unwrap_or_default());
    }
    if let Some(state) = action.state.as_ref().and_then(|s| serde_json::to_value(s).ok())
        && state.as_object().is_some_and(|fields| !fields.is_empty())
    {
        payload.insert("state".into(), state);
    }
    let mut lines = vec![format!("{VIEW_ACTION_PREFIX} {label}")];
    if let Some(extra) = said.map(str::trim).filter(|extra| !extra.is_empty() && *extra != label) {
        lines.push(extra.to_owned());
    }
    lines.push(Value::Object(payload).to_string());
    ViewActionTurn {
        text: lines.join("\n"),
        display_text: label.clone(),
        action: UserMessageAction { view_id: action.view_id.clone(), label, view_title: action.view_title.clone() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_click_becomes_a_turn_the_agent_can_read() {
        let click: ViewAction = serde_json::from_value(json!({
            "viewId": "v_abcdefghijkl", "actionId": "book", "label": " Book it ", "viewTitle": "Cafes",
            "item": {"type": "Place", "id": "p1"}, "state": {"tab": "map"}
        }))
        .expect("a view action");
        let turn = view_action_turn(&click, Some("for two"));
        let mut lines = turn.text.lines();
        assert_eq!(lines.next(), Some("[view action] Book it"));
        assert_eq!(lines.next(), Some("for two"));
        let payload: Value = serde_json::from_str(lines.next().expect("the payload")).expect("json");
        assert_eq!(payload["viewId"], "v_abcdefghijkl");
        assert_eq!(payload["actionId"], "book");
        assert_eq!(payload["state"], json!({"tab": "map"}));
        assert!(payload.get("item").is_some());
        assert_eq!(turn.display_text, "Book it");
        assert_eq!(
            serde_json::to_value(&turn.action).expect("json"),
            json!({"viewId": "v_abcdefghijkl", "label": "Book it", "viewTitle": "Cafes"})
        );

        // The label typed again adds nothing; a click without a label goes by its action.
        let bare: ViewAction =
            serde_json::from_value(json!({"viewId": "v_abcdefghijkl", "actionId": "refresh", "label": ""}))
                .expect("a view action");
        let turn = view_action_turn(&bare, Some("refresh"));
        assert_eq!(turn.text, "[view action] refresh\n{\"viewId\":\"v_abcdefghijkl\",\"actionId\":\"refresh\"}");
    }
}
