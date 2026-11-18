//! The Freedom and Goes-to slots of a routine's blueprint: how far a run's
//! results go without the user, and to whom. Shapes only; the rules over them
//! (the rung a result gets, the caps that hold it) are `eos_domain::freedom`.
//! Every object keeps the keys this version does not know, after the ones it
//! knows, because a blueprint stores these slots and a newer Eos may add a
//! field to them that this one must not drop.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::signals::Rule;
use crate::validate::Validate;

/// What an action does, which decides how freely it may happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass {
    Read,
    /// Writes on this computer only: the run's worktree, its scratch folder,
    /// Eos's own surfaces.
    WriteLocal,
    /// Tells the user, and nobody else.
    TellUser,
    /// Speaks for the user to someone else.
    Speak,
    /// Cannot be taken back, or costs money.
    Irreversible,
}

impl Validate for ActionClass {}

/// How far a result goes without the user. Declared from the least freedom
/// to the most, so the order compares them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Rung {
    /// A triggered run waits for the user before it starts; its result is
    /// held.
    Ask,
    /// The result is held until the user sends it.
    Draft,
    SendThenTell,
    OnItsOwn,
}

impl Validate for Rung {}

/// `{"rung": "draft", "grants": [{"id": "docs", "when": {…}, "rung": "on_its_own", "coversIrreversible": false}]}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Freedom {
    pub rung: Rung,
    #[serde(default)]
    pub grants: Vec<Grant>,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Freedom {}

/// More freedom for the items whose facts pass `when`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub when: Rule,
    pub rung: Rung,
    /// The grant reaches actions that cannot be undone too, which the user
    /// confirmed by typing.
    #[serde(default)]
    pub covers_irreversible: bool,
    /// Keys this version does not know; kept so a round trip loses nothing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Validate for Grant {}

/// One entry of the Goes-to slot: `{"id", "kind", "channel", "address"?, "bound"?}`.
/// The id is stable and unique in its blueprint: deliveries and mail parts
/// name the recipient by it. Its kind keeps the keys this version does not
/// know: a map beside the flattened kind would hold the kind's keys twice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Recipient {
    pub id: String,
    #[serde(flatten)]
    pub kind: RecipientKind,
}

impl Validate for Recipient {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecipientKind {
    /// The user, on one of their own channels.
    Me {
        channel: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// One address the user wrote into the routine.
    Fixed {
        channel: String,
        address: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// The place the item names (its pull request, the sender of its mail),
    /// held to the items whose facts pass `bound`.
    ItemPlace {
        channel: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bound: Option<Rule>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

impl Validate for RecipientKind {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn classes_and_rungs_use_their_snake_case_names() {
        let classes = [
            ActionClass::Read,
            ActionClass::WriteLocal,
            ActionClass::TellUser,
            ActionClass::Speak,
            ActionClass::Irreversible,
        ];
        assert_eq!(
            serde_json::to_value(classes).unwrap(),
            json!(["read", "write_local", "tell_user", "speak", "irreversible"])
        );
        let rungs = [Rung::Ask, Rung::Draft, Rung::SendThenTell, Rung::OnItsOwn];
        assert_eq!(serde_json::to_value(rungs).unwrap(), json!(["ask", "draft", "send_then_tell", "on_its_own"]));
        assert!(rungs.windows(2).all(|pair| pair[0] < pair[1]), "declared from least to most freedom");
        assert!(crate::read::<ActionClass>(&json!("speak_for_user")).is_err());
    }

    #[test]
    fn freedom_reads_and_writes_back_the_same() {
        let freedom = json!({
            "rung": "draft",
            "grants": [{
                "id": "docs",
                "when": {"fact": "paths", "glob": "docs/**"},
                "rung": "on_its_own",
                "coversIrreversible": true,
            }],
        });
        let read: Freedom = crate::read(&freedom).unwrap();
        assert_eq!(read.grants[0].rung, Rung::OnItsOwn);
        assert!(read.grants[0].covers_irreversible);
        assert_eq!(serde_json::to_value(&read).unwrap(), freedom);

        let bare: Freedom = crate::read(&json!({"rung": "ask", "later": 1})).unwrap();
        let later = json!({"later": 1}).as_object().unwrap().clone();
        assert_eq!(bare, Freedom { rung: Rung::Ask, grants: Vec::new(), extra: later });
        let grant: Grant =
            crate::read(&json!({"id": "g", "when": {"fact": "draft", "is": false}, "rung": "draft"})).unwrap();
        assert!(!grant.covers_irreversible);
    }

    #[test]
    fn each_recipient_kind_reads_and_writes_back_the_same_id_first() {
        for recipient in [
            json!({"id": "me", "kind": "me", "channel": "notify"}),
            json!({"id": "lead", "kind": "fixed", "channel": "mail", "address": "lead@example.com"}),
            json!({"id": "pr", "kind": "item_place", "channel": "github", "bound": {"fact": "repo", "in": ["acme/game"]}}),
            json!({"id": "sender", "kind": "item_place", "channel": "mail"}),
        ] {
            let read: Recipient = crate::read(&recipient).unwrap();
            let written = serde_json::to_string(&read).unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&written).unwrap(), recipient);
            assert!(written.starts_with(r#"{"id":"#) && written.contains(r#","kind":"#), "{written}");
        }
        let place: Recipient =
            crate::read(&json!({"id": "pr", "kind": "item_place", "channel": "github", "x": 1})).unwrap();
        let x = json!({"x": 1}).as_object().unwrap().clone();
        assert_eq!(place.kind, RecipientKind::ItemPlace { channel: "github".into(), bound: None, extra: x });
        assert!(crate::read::<Recipient>(&json!({"id": "x", "kind": "fixed", "channel": "mail"})).is_err());
        assert!(crate::read::<Recipient>(&json!({"id": "x", "kind": "anyone", "channel": "mail"})).is_err());
        assert!(crate::read::<Recipient>(&json!({"kind": "me", "channel": "notify"})).is_err(), "an id is required");
    }

    #[test]
    fn every_object_keeps_the_keys_it_does_not_know_after_the_ones_it_knows() {
        let freedom = concat!(
            r#"{"rung":"draft","grants":[{"id":"docs","when":{"fact":"paths","glob":"docs/**","t":1},"#,
            r#""rung":"on_its_own","coversIrreversible":false,"g":1}],"later":{"x":[1]}}"#,
        );
        let read: Freedom = crate::read(&serde_json::from_str(freedom).unwrap()).unwrap();
        assert_eq!(serde_json::to_string(&read).unwrap(), freedom);
        for recipient in [
            r#"{"id":"me","kind":"me","channel":"notify","m":1}"#,
            r#"{"id":"lead","kind":"fixed","channel":"mail","address":"lead@example.com","f":null}"#,
            r#"{"id":"pr","kind":"item_place","channel":"github","bound":{"fact":"repo","in":["acme/game"],"b":1},"p":[2]}"#,
        ] {
            let read: Recipient = crate::read(&serde_json::from_str(recipient).unwrap()).unwrap();
            assert_eq!(serde_json::to_string(&read).unwrap(), recipient);
        }
        let shuffled = r#"{"p":1,"channel":"notify","kind":"me","id":"me"}"#;
        let read: Recipient = crate::read(&serde_json::from_str(shuffled).unwrap()).unwrap();
        assert_eq!(serde_json::to_string(&read).unwrap(), r#"{"id":"me","kind":"me","channel":"notify","p":1}"#);
    }
}
