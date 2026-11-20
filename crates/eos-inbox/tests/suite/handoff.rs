//! An answer waits for its producer until the producer marks it, across a
//! restart.

use eos_contracts::{ConfirmChoice, InboxAnswer};
use eos_domain::inbox::ItemKind;
use eos_inbox::consume_in;
use eos_testkit::TempStore;

use crate::rig::{Rig, new_item};

#[tokio::test]
async fn an_answered_item_is_handed_to_its_producer_until_it_is_consumed_even_after_a_restart() {
    let rig = Rig::new();
    let item = rig.open(new_item(ItemKind::ConfirmChange, None)).await;
    let mut other = new_item(ItemKind::Notice, None);
    other.producer = "signals".into();
    let other = rig.open(other).await;
    let answer = InboxAnswer::ConfirmChange { choice: ConfirmChoice::Confirm };
    rig.items.answer(&item.id, 1, &answer, "phone").await.expect("answers");
    rig.items.discard(&other.id, 1, "dashboard").await.expect("discards");

    let handed = rig.items.unconsumed("routines").await.expect("reads");
    assert_eq!(handed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), [item.id.as_str()]);

    // The app quits before the producer acted: the answer is handed over again.
    let Rig { temp: TempStore { store, home, .. }, .. } = rig;
    drop(store);
    let rig = Rig::on(TempStore::in_home(home));
    let handed = rig.items.unconsumed("routines").await.expect("reads");
    assert_eq!(handed.len(), 1);

    let id = item.id.clone();
    let (first, second) = rig
        .temp
        .port()
        .write(move |tx, _| Ok((consume_in(tx, &id, 3_000_000)?, consume_in(tx, &id, 3_000_001)?)))
        .await
        .expect("consumes");
    assert_eq!((first, second), (true, false));
    assert!(rig.items.unconsumed("routines").await.expect("reads").is_empty());
    assert_eq!(rig.items.unconsumed("signals").await.expect("reads").len(), 1, "each producer has its own");
}
