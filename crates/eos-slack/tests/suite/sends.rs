//! Posting as the user: to a channel, to a person through their direct
//! message, in a thread and to oneself, with broadcasts escaped, links not
//! unfurled, a marker found again after a lost answer, and a delete.

use eos_core::capability::{ActionError, FailureKind};
use serde_json::json;

use crate::rig::{CHANNEL, rig};

#[tokio::test]
async fn a_post_goes_as_the_user_with_broadcasts_escaped_and_no_preview() {
    let rig = rig();
    let ctx = rig.ctx(Some("dl-0123456789ab"));
    let text = "<!channel> <!here|here> <!subteam^S01|core> build is green: <https://ci.acme.dev/1|run>";
    let receipt = rig.call_in("post_message", json!({"to": CHANNEL, "text": text}), &ctx).await.expect("posted");
    assert_eq!(receipt["conversation"], CHANNEL);
    assert!(receipt["permalink"].as_str().is_some_and(|link| link.starts_with("https://acme.slack.com/archives/")));
    let post = &rig.fake.calls_of("chat.postMessage")[0];
    for (field, value) in
        [("parse", "none"), ("link_names", "false"), ("unfurl_links", "false"), ("unfurl_media", "false")]
    {
        assert_eq!(post.fields[field], value, "{field}");
    }
    assert_eq!(
        post.fields["text"],
        "&lt;!channel> &lt;!here|here> &lt;!subteam^S01|core> build is green: <https://ci.acme.dev/1|run>"
    );
    let metadata: serde_json::Value = serde_json::from_str(&post.fields["metadata"]).expect("json");
    assert_eq!(metadata, json!({"event_type": "eos_delivery", "event_payload": {"key": "dl-0123456789ab"}}));

    let found = rig.call("find_delivery", json!({"conversation": CHANNEL, "key": "dl-0123456789ab", "since": 0})).await;
    assert_eq!(found.expect("looked up")["found"], true, "a lost answer is found by its marker");
    let other = rig.call("find_delivery", json!({"conversation": CHANNEL, "key": "dl-ffffffffffff", "since": 0})).await;
    assert_eq!(other.expect("looked up")["found"], false);
}

#[tokio::test]
async fn a_person_and_the_user_are_reached_through_their_direct_message_and_a_thread_by_its_parent() {
    let rig = rig();
    let to_bob = rig.call("post_message", json!({"to": "U0BOB0001", "text": "Your report is ready."})).await;
    assert_eq!(to_bob.expect("posted")["conversation"], "DU0BOB0001");
    let me = rig.call("tell_me", json!({"text": "Done."})).await.expect("told");
    assert_eq!(me["conversation"], "DU0ME00001");
    let parent = rig.fake.message(CHANNEL, "U0BOB0001", "Can someone look?");
    let reply = json!({"conversation": CHANNEL, "threadTs": parent, "text": "On it."});
    rig.call("reply_in_thread", reply).await.expect("replied");
    assert_eq!(rig.fake.messages(CHANNEL).last().expect("a reply")["thread_ts"], parent.as_str());
    // One post a second in a conversation.
    rig.clock.advance(1_000);
    let gone = json!({"conversation": CHANNEL, "threadTs": "1.000100", "text": "On it."});
    assert_eq!(rig.call("reply_in_thread", gone).await, Err(ActionError::Failed { kind: FailureKind::Gone }));
}

#[tokio::test]
async fn a_text_over_four_thousand_characters_is_refused_unsent_and_a_delete_takes_a_post_back() {
    let rig = rig();
    let long = "a".repeat(4_001);
    let refused = rig.call("post_message", json!({"to": CHANNEL, "text": long})).await;
    assert!(matches!(refused, Err(ActionError::Invalid(_))), "{refused:?}");
    assert!(rig.fake.calls_of("chat.postMessage").is_empty());

    let receipt = rig.call("post_message", json!({"to": CHANNEL, "text": "Hello."})).await.expect("posted");
    let undo = json!({"conversation": CHANNEL, "ts": receipt["ts"]});
    assert_eq!(rig.call("delete_message", undo.clone()).await.expect("deleted"), json!({"deleted": true}));
    assert!(rig.fake.messages(CHANNEL).is_empty());
    rig.fake.refuse("chat.delete", "cant_delete_message");
    assert_eq!(rig.call("delete_message", undo).await, Err(ActionError::Failed { kind: FailureKind::NotAllowed }));
}
