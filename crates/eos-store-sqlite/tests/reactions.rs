//! `message_reactions`: one emoji per actor per message, what the agent was
//! told of the user's, and the rows that go with their messages.

use eos_contracts::ReactionActor::{Agent, User};
use eos_contracts::WorkerEventType;
use eos_core::store::StoredReaction;
use eos_testkit::TempStore;

/// Two messages of `w-CHAT` and one of `o-ORCH`, by row id.
fn messages(temp: &TempStore) -> (i64, i64, i64) {
    temp.store
        .write_blocking(|tx, _| {
            let say = |worker: &str, text: &str| {
                tx.events().append(worker, 1, WorkerEventType::UserMessage, Some(&format!("{{\"text\":\"{text}\"}}")))
            };
            Ok((say("w-CHAT", "one")?, say("w-CHAT", "two")?, say("o-ORCH", "three")?))
        })
        .expect("writes")
}

fn brief(rows: &[StoredReaction]) -> Vec<(i64, &str, Option<&str>, Option<&str>)> {
    rows.iter().map(|r| (r.event_id, r.actor.as_str(), r.emoji.as_deref(), r.told.as_deref())).collect()
}

#[test]
fn each_actor_has_one_emoji_a_message_and_the_agent_hears_only_what_changed() {
    let temp = TempStore::seeded("/sandbox");
    let (one, two, three) = messages(&temp);
    let outcome = temp
        .store
        .write_blocking(move |tx, _| {
            let r = tx.reactions();
            r.set("w-CHAT", one, User, Some("👍"), 10)?;
            r.set("w-CHAT", one, User, Some("👎"), 11)?;
            r.set("w-CHAT", one, Agent, Some("❤️"), 12)?;
            r.set("w-CHAT", two, User, Some("📌"), 13)?;
            r.set("o-ORCH", three, User, Some("👀"), 14)?;
            let listed = r.list("w-CHAT", 0, i64::MAX, 10)?;
            let window = r.list("w-CHAT", two, two, 10)?;
            let untold = r.untold("w-CHAT", 10)?;
            let newest = r.untold("w-CHAT", 1)?;

            // Told: nothing left to tell, until it changes again.
            r.set_told(one, Some("👎"))?;
            r.set_told(two, Some("📌"))?;
            let none = r.untold("w-CHAT", 10)?;
            r.set("w-CHAT", one, User, Some("👍"), 20)?;
            let changed = r.untold("w-CHAT", 10)?;
            // Taken back after it was told: the row stays until the agent hears of that too.
            r.set("w-CHAT", two, User, None, 21)?;
            let taken_back = r.untold("w-CHAT", 10)?;
            let shown = r.list("w-CHAT", 0, i64::MAX, 10)?;
            r.set_told(two, None)?;
            let gone = r.find(two, User)?;
            // Taken back before anyone heard: nothing is kept; the agent's own goes at once.
            r.set("o-ORCH", three, User, None, 22)?;
            r.set("w-CHAT", one, Agent, None, 23)?;
            let left = (r.find(three, User)?, r.find(one, Agent)?);
            Ok((listed, window, untold, newest, none, changed, taken_back, shown, gone, left))
        })
        .expect("writes");
    let (listed, window, untold, newest, none, changed, taken_back, shown, gone, left) = outcome;
    assert_eq!(
        brief(&listed),
        [(one, "user", Some("👎"), None), (one, "agent", Some("❤️"), None), (two, "user", Some("📌"), None)],
        "the later emoji replaced the earlier; the user's first on a message both reacted to"
    );
    assert_eq!(listed[0].at, 11);
    assert_eq!(brief(&window), [(two, "user", Some("📌"), None)], "a range of rows");
    assert_eq!(brief(&untold), [(one, "user", Some("👎"), None), (two, "user", Some("📌"), None)]);
    assert_eq!(brief(&newest), [(two, "user", Some("📌"), None)], "the newest messages first when there are too many");
    assert!(none.is_empty());
    assert_eq!(brief(&changed), [(one, "user", Some("👍"), Some("👎"))]);
    assert_eq!(brief(&taken_back)[1], (two, "user", None, Some("📌")));
    assert!(shown.iter().all(|r| r.event_id == one), "a reaction taken back is not shown: {shown:?}");
    assert_eq!((gone, left), (None, (None, None)));
}

#[test]
fn reactions_go_with_their_messages() {
    let temp = TempStore::seeded("/sandbox");
    let (one, two, three) = messages(&temp);
    let count = |temp: &TempStore| temp.count("SELECT COUNT(*) FROM message_reactions");
    temp.store
        .write_blocking(move |tx, _| {
            for (worker, row) in [("w-CHAT", one), ("w-CHAT", two), ("o-ORCH", three)] {
                tx.reactions().set(worker, row, User, Some("👍"), 1)?;
            }
            Ok(())
        })
        .expect("writes");
    assert_eq!(count(&temp), 3);

    // A message removed by a build that does not know the table.
    temp.exec(&format!("DELETE FROM events WHERE id = {two}"));
    let swept = temp.store.write_blocking(|tx, _| tx.reactions().sweep_orphans()).expect("sweeps");
    assert_eq!((swept, count(&temp)), (1, 2));

    // The log's bound cuts a chat's oldest rows: their reactions go too.
    let pruned = temp
        .store
        .write_blocking(|tx, _| {
            tx.events().append("w-CHAT", 2, WorkerEventType::UserMessage, Some("{\"text\":\"newer\"}"))?;
            tx.events().prune_all(1)
        })
        .expect("prunes");
    assert!(pruned > 0);
    assert_eq!(count(&temp), 1, "each chat keeps its newest row, and w-CHAT's reacted one is older");
    assert_eq!(temp.count(&format!("SELECT COUNT(*) FROM message_reactions WHERE event_id = {three}")), 1);

    temp.store.write_blocking(|tx, _| tx.events().delete_by_worker("o-ORCH")).expect("deletes");
    assert_eq!(count(&temp), 0);
}
