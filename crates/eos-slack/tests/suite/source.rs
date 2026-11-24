//! The sources: a baseline first, then what came after the cursor; a
//! message Eos posted is never a signal; a mention is counted once; under a
//! long Retry-After the conversations take turns.

use serde_json::{Value, json};

use crate::rig::{CHANNEL, rig};

fn keys(polled: &Value) -> Vec<String> {
    polled["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["key"].as_str().expect("a key").to_owned())
        .collect()
}

#[tokio::test]
async fn messages_start_from_a_baseline_and_then_bring_what_came_after_the_cursor() {
    let rig = rig();
    rig.fake.message(CHANNEL, "U0BOB0001", "old news");
    let first = rig.call("poll_messages", json!({"conversation": CHANNEL})).await.expect("polled");
    assert_eq!((first["baseline"].as_bool(), keys(&first).len()), (Some(true), 0), "the first poll only marks");

    let ts = rig.fake.message(CHANNEL, "U0BOB0001", "Hey <@U0ME00001>, can you check the build?");
    let own = rig.ctx(Some("dl-0123456789ab"));
    rig.call_in("post_message", json!({"to": CHANNEL, "text": "Build is fine."}), &own).await.expect("posted");
    let next =
        rig.call("poll_messages", json!({"conversation": CHANNEL, "cursor": first["cursor"]})).await.expect("polled");
    assert_eq!(keys(&next), [format!("slack:T0ACME001:{CHANNEL}:{ts}")], "Eos's own post is never a signal");
    let facts = &next["items"][0]["facts"];
    assert_eq!(
        facts,
        &json!({"conversation": CHANNEL, "from": "U0BOB0001", "fromMe": false, "mentionsMe": true,
                              "isDm": false, "inThread": false})
    );
    assert_eq!(next["items"][0]["event"], "posted");
    let again =
        rig.call("poll_messages", json!({"conversation": CHANNEL, "cursor": next["cursor"]})).await.expect("polled");
    assert!(keys(&again).is_empty(), "nothing twice");
    let history = rig.fake.calls_of("conversations.history");
    let last = history.last().expect("a read");
    assert_eq!((last.fields["inclusive"].as_str(), last.fields["oldest"].is_empty()), ("true", false));
}

#[tokio::test]
async fn a_mention_is_counted_once_and_ones_own_never() {
    let rig = rig();
    let first = rig.call("poll_mentions", json!({})).await.expect("polled");
    assert_eq!(first["baseline"], true);
    rig.fake.message(CHANNEL, "U0BOB0001", "<@U0ME00001> please review");
    rig.fake.message(CHANNEL, "U0ME00001", "note to <@U0ME00001>");
    let next = rig.call("poll_mentions", json!({"cursor": first["cursor"]})).await.expect("polled");
    assert_eq!(keys(&next).len(), 1);
    assert_eq!(next["items"][0]["event"], "mentioned");
    let again = rig.call("poll_mentions", json!({"cursor": next["cursor"]})).await.expect("polled");
    assert!(keys(&again).is_empty(), "search lags, but a mention seen is not seen again");
}

#[tokio::test]
async fn under_a_long_retry_after_the_conversations_take_turns() {
    let rig = rig();
    rig.fake.conversation("C0RANDOM01", "random");
    rig.fake.limit("conversations.history", 60);
    let a = rig.call("poll_messages", json!({"conversation": CHANNEL, "cursor": {"ts": "1"}})).await.expect("waits");
    let b =
        rig.call("poll_messages", json!({"conversation": "C0RANDOM01", "cursor": {"ts": "1"}})).await.expect("waits");
    assert_eq!((a["pollAfterS"].as_u64(), b["pollAfterS"].as_u64()), (Some(60), Some(120)), "one after the other");
    assert_eq!(rig.fake.calls_of("conversations.history").len(), 1, "only the first asked Slack");
    rig.fake.unlimit("conversations.history");
    rig.clock.advance(61_000);
    let b_early =
        rig.call("poll_messages", json!({"conversation": "C0RANDOM01", "cursor": {"ts": "1"}})).await.expect("waits");
    assert_eq!(b_early["pollAfterS"], 60, "its turn comes after the first's");
    rig.call("poll_messages", json!({"conversation": CHANNEL, "cursor": {"ts": "1"}})).await.expect("read");
    let b_now =
        rig.call("poll_messages", json!({"conversation": "C0RANDOM01", "cursor": {"ts": "1"}})).await.expect("read");
    assert_eq!(b_now["pollAfterS"], 60);
    assert_eq!(rig.fake.calls_of("conversations.history").len(), 3);
}
