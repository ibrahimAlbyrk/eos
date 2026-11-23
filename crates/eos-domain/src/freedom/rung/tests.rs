use eos_contracts::{Grant, Rule};
use serde_json::{Value, json};

use super::*;

const CLASSES: [ActionClass; 5] =
    [ActionClass::Read, ActionClass::WriteLocal, ActionClass::TellUser, ActionClass::Speak, ActionClass::Irreversible];
const RUNGS: [Rung; 4] = [Rung::Ask, Rung::Draft, Rung::SendThenTell, Rung::OnItsOwn];

fn freedom(rung: Rung, grants: Vec<Grant>) -> Freedom {
    Freedom { rung, grants, extra: Default::default() }
}

fn grant(when: Value, rung: Rung, covers_irreversible: bool) -> Grant {
    let when: Rule = serde_json::from_value(when).expect("a rule");
    Grant { id: "g".into(), when, rung, covers_irreversible, extra: Default::default() }
}

fn facts(value: Value) -> Facts {
    serde_json::from_value(value).expect("facts")
}

/// One caps value per cap, each alone, the age caps just past their limit.
fn each_cap() -> Vec<(&'static str, Caps)> {
    let none = Caps::default();
    vec![
        ("agent origin", Caps { agent_origin: true, ..none }),
        ("unbounded place", Caps { unbounded_place: true, ..none }),
        ("outbound flags", Caps { flagged: true, ..none }),
        ("stale", Caps { stale: true, ..none }),
        (
            "approved over an hour ago",
            Caps { waiting: Some(Waiting::Approved { for_ms: APPROVED_FRESH_MS + 1 }), ..none },
        ),
        (
            "automatic over a day ago",
            Caps { waiting: Some(Waiting::Automatic { for_ms: AUTOMATIC_FRESH_MS + 1 }), ..none },
        ),
        ("halt", Caps { halted: true, ..none }),
        ("a repeat to the same recipient and subject", Caps { repeat: true, ..none }),
    ]
}

/// Per class and confirmed rung, with no grant: the rung with no cap, and
/// with any one cap.
fn expected(class: ActionClass, rung: Rung) -> (Rung, Rung) {
    use ActionClass::{Irreversible, Read, Speak, TellUser, WriteLocal};
    use Rung::{Ask, Draft, OnItsOwn, SendThenTell};
    match (class, rung) {
        (Read | WriteLocal, _) => (OnItsOwn, OnItsOwn),
        (TellUser, _) => (OnItsOwn, Draft),
        (Speak, Ask) => (Ask, Ask),
        (Speak, Draft) => (Draft, Draft),
        (Speak, SendThenTell) => (SendThenTell, Draft),
        (Speak, OnItsOwn) => (OnItsOwn, Draft),
        (Irreversible, Ask) => (Ask, Ask),
        (Irreversible, Draft | SendThenTell | OnItsOwn) => (Draft, Draft),
    }
}

#[test]
fn every_class_at_every_rung_under_every_cap() {
    let no_facts = Facts::new();
    for class in CLASSES {
        for rung in RUNGS {
            let (free, capped) = expected(class, rung);
            let confirmed = freedom(rung, Vec::new());
            assert_eq!(effective_rung(class, &confirmed, &no_facts, &Caps::default()), free, "{class:?} at {rung:?}");
            for (cap, caps) in each_cap() {
                assert_eq!(effective_rung(class, &confirmed, &no_facts, &caps), capped, "{class:?} at {rung:?}, {cap}");
            }
        }
    }
}

#[test]
fn the_age_caps_hold_only_past_their_limit() {
    let at = |waiting| Caps { waiting: Some(waiting), ..Caps::default() }.holds();
    assert!(!at(Waiting::Approved { for_ms: 0 }));
    assert!(!at(Waiting::Approved { for_ms: 60 * 60 * 1000 }));
    assert!(at(Waiting::Approved { for_ms: 60 * 60 * 1000 + 1 }));
    assert!(!at(Waiting::Automatic { for_ms: 24 * 60 * 60 * 1000 }));
    assert!(at(Waiting::Automatic { for_ms: 24 * 60 * 60 * 1000 + 1 }));
    // An approval a day old is long stale; an automatic send two hours old is not.
    assert!(!at(Waiting::Automatic { for_ms: 2 * 60 * 60 * 1000 }));
    assert!(!Caps::default().holds());
}

#[test]
fn a_grant_adds_freedom_to_the_items_whose_facts_pass_it() {
    let docs_only = json!({"fact": "paths", "glob": "docs/**"});
    let confirmed = freedom(Rung::Draft, vec![grant(docs_only, Rung::OnItsOwn, false)]);
    let docs = facts(json!({"paths": ["docs/setup.md"]}));
    let code = facts(json!({"paths": ["src/main.rs"]}));
    let none = Caps::default();
    assert_eq!(effective_rung(ActionClass::Speak, &confirmed, &docs, &none), Rung::OnItsOwn);
    assert_eq!(effective_rung(ActionClass::Speak, &confirmed, &code, &none), Rung::Draft);
    // A fact the item lacks passes no grant.
    assert_eq!(effective_rung(ActionClass::Speak, &confirmed, &Facts::new(), &none), Rung::Draft);
    // Every cap holds a granted result too.
    for (cap, caps) in each_cap() {
        assert_eq!(effective_rung(ActionClass::Speak, &confirmed, &docs, &caps), Rung::Draft, "{cap}");
    }
}

#[test]
fn a_grant_never_takes_freedom_away_and_the_freest_passing_grant_wins() {
    let any = json!({"fact": "draft", "is": false});
    let item = facts(json!({"draft": false}));
    let none = Caps::default();
    let lower = freedom(Rung::SendThenTell, vec![grant(any.clone(), Rung::Ask, false)]);
    assert_eq!(effective_rung(ActionClass::Speak, &lower, &item, &none), Rung::SendThenTell);
    let several = freedom(
        Rung::Ask,
        vec![
            grant(any.clone(), Rung::Draft, false),
            grant(any.clone(), Rung::SendThenTell, false),
            grant(json!({"fact": "draft", "is": true}), Rung::OnItsOwn, false),
        ],
    );
    assert_eq!(effective_rung(ActionClass::Speak, &several, &item, &none), Rung::SendThenTell);
    // Telling the user and the local classes do not read grants.
    let held = freedom(Rung::Ask, vec![grant(any, Rung::Ask, true)]);
    assert_eq!(effective_rung(ActionClass::TellUser, &held, &item, &none), Rung::OnItsOwn);
    assert_eq!(effective_rung(ActionClass::WriteLocal, &held, &item, &none), Rung::OnItsOwn);
}

#[test]
fn an_irreversible_action_goes_only_under_a_grant_that_covers_it() {
    let docs_only = json!({"fact": "paths", "glob": "docs/**"});
    let docs = facts(json!({"paths": ["docs/setup.md"]}));
    let none = Caps::default();
    let speak_only = freedom(Rung::OnItsOwn, vec![grant(docs_only.clone(), Rung::OnItsOwn, false)]);
    assert_eq!(effective_rung(ActionClass::Irreversible, &speak_only, &docs, &none), Rung::Draft);
    assert_eq!(effective_rung(ActionClass::Speak, &speak_only, &docs, &none), Rung::OnItsOwn);
    let covering = freedom(Rung::Draft, vec![grant(docs_only, Rung::OnItsOwn, true)]);
    assert_eq!(effective_rung(ActionClass::Irreversible, &covering, &docs, &none), Rung::OnItsOwn);
    assert_eq!(effective_rung(ActionClass::Speak, &covering, &docs, &none), Rung::OnItsOwn);
    let code = facts(json!({"paths": ["src/main.rs"]}));
    assert_eq!(effective_rung(ActionClass::Irreversible, &covering, &code, &none), Rung::Draft);
    let halted = Caps { halted: true, ..none };
    assert_eq!(effective_rung(ActionClass::Irreversible, &covering, &docs, &halted), Rung::Draft);
}
