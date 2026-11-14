//! The Machines menu's computers: ⌃1 is always this
//! computer, the controlled ones follow in the list's order, eight at most.

use serde_json::Value;

/// The most controlled computers the menu lists.
const LISTED: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineItem {
    /// The host's id; `None` for this computer.
    pub id: Option<String>,
    pub label: String,
    pub checked: bool,
    pub accelerator: String,
}

/// The items for `{hosts, active, local}` as [`super::HostViews::snapshot`] gives it.
pub fn machine_items(snapshot: &Value) -> Vec<MachineItem> {
    let active = snapshot.get("active").and_then(Value::as_str);
    let mut items = vec![MachineItem {
        id: None,
        label: "This Mac".to_owned(),
        checked: active.is_none(),
        accelerator: "Ctrl+1".to_owned(),
    }];
    let hosts = snapshot.get("hosts").and_then(Value::as_array).into_iter().flatten();
    for (n, host) in hosts.filter_map(|h| Some((h.get("id")?.as_str()?, h))).take(LISTED).enumerate() {
        let (id, host) = host;
        let named = |key: &str| host.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        items.push(MachineItem {
            id: Some(id.to_owned()),
            label: named("alias").or_else(|| named("name")).unwrap_or(id).to_owned(),
            checked: active == Some(id),
            accelerator: format!("Ctrl+{}", n + 2),
        });
    }
    items
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn this_computer_first_then_eight_hosts_by_alias_or_name() {
        let hosts: Vec<Value> =
            (0..10).map(|n| json!({ "id": format!("h{n}"), "name": format!("Mac {n}"), "alias": null })).collect();
        let mut snapshot = json!({ "hosts": hosts, "active": "h1", "local": null });
        snapshot["hosts"][0]["alias"] = json!("Studio");
        let items = machine_items(&snapshot);
        assert_eq!(items.len(), 9);
        assert_eq!(
            items[0],
            MachineItem { id: None, label: "This Mac".into(), checked: false, accelerator: "Ctrl+1".into() }
        );
        assert_eq!(items[1].label, "Studio");
        assert_eq!(
            (items[2].id.as_deref(), items[2].checked, items[2].accelerator.as_str()),
            (Some("h1"), true, "Ctrl+3")
        );
        assert_eq!(items[8].accelerator, "Ctrl+9");
        assert!(machine_items(&json!({ "hosts": [], "active": null }))[0].checked);
    }
}
