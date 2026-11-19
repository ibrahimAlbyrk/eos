//! Whether a run reads outside text (01 G46): computed on read from what it
//! runs from, never stored.

use eos_contracts::RunInput;

use crate::run_scope::Trust;

/// A run is untrusted when its version is (or the version's trust is a word
/// this app does not know), or when any item it was given came from outside.
pub fn of_run(version: Option<Trust>, input: &RunInput) -> Trust {
    let outside = input.item.iter().chain(input.items.iter().flatten()).any(|item| item.untrusted);
    if outside || version != Some(Trust::Trusted) { Trust::Untrusted } else { Trust::Trusted }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn input(value: serde_json::Value) -> RunInput {
        let mut value = value;
        value["result"] = json!("usual");
        serde_json::from_value(value).expect("an input")
    }

    fn item(untrusted: bool) -> serde_json::Value {
        json!({"kind": "text", "untrusted": untrusted})
    }

    #[test]
    fn a_run_is_untrusted_by_its_version_or_by_any_item_from_outside() {
        let plain = input(json!({}));
        assert_eq!(of_run(Some(Trust::Trusted), &plain), Trust::Trusted);
        assert_eq!(of_run(Some(Trust::Untrusted), &plain), Trust::Untrusted);
        assert_eq!(of_run(None, &plain), Trust::Untrusted, "an unknown word is the careful one");
        let one = input(json!({"item": item(true)}));
        assert_eq!(of_run(Some(Trust::Trusted), &one), Trust::Untrusted);
        let batch = input(json!({"items": [item(false), item(true)]}));
        assert_eq!(of_run(Some(Trust::Trusted), &batch), Trust::Untrusted);
        let inside = input(json!({"items": [item(false)]}));
        assert_eq!(of_run(Some(Trust::Trusted), &inside), Trust::Trusted);
    }
}
