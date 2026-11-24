//! The `slack` channel over the Slack built-in on `FakeSlack`: a message
//! goes only where its delivery's target says (a channel, a person, the
//! user, a thread), with broadcasts escaped and no previews; 4,000+
//! characters are refused unsent; a send after a lost answer is found by its
//! marker; undo deletes, or says the workspace forbids it; both result
//! kinds have their shape.

use std::sync::Arc;

use eos_contracts::{Part, ResultDoc};
use eos_core::capability::CapabilityReads;
use eos_core::delivery::{Idempotency, Place, SendRequest, Target, Undo, UndoOutcome};
use eos_testkit::{FakeCapabilitySecrets, FakeClock, FakeSlack};

use crate::rig::{Rig, Setup, rig};

const CHANNEL: &str = "C0GENERAL1";

async fn slack_rig() -> (Rig, Arc<FakeSlack>, Arc<FakeClock>) {
    let fake = Arc::new(FakeSlack::new().signed_in());
    fake.conversation(CHANNEL, "general");
    let secrets = FakeCapabilitySecrets::new().with("slack", "token", &fake.token_secret(i64::MAX / 2));
    let clock = Arc::new(FakeClock::at(1_000));
    let rig = rig(Setup { builtins: vec![fake.builtin(clock.clone())], secrets, ..Setup::default() }).await;
    (rig, fake, clock)
}

fn message(text: &str) -> ResultDoc {
    let part = Part { key: "p:1".into(), role: "paragraph".into(), text: text.into(), meta: Default::default() };
    ResultDoc {
        kind: "slack.message".into(),
        channel: "slack".into(),
        action: "post_message".into(),
        parts: vec![part],
    }
}

fn request(key: &str, place: Place, body: ResultDoc) -> SendRequest {
    SendRequest {
        key: key.into(),
        channel: "slack".into(),
        action: body.action.clone(),
        target: Target { recipient_id: "team".into(), place },
        body,
    }
}

#[tokio::test]
async fn a_message_goes_only_where_its_delivery_points_escaped_and_without_previews() {
    let (rig, fake, clock) = slack_rig().await;
    let channel = rig.service.channels().get("slack").expect("a slack channel");
    let traits = channel.traits("post_message").expect("traits");
    assert_eq!((traits.idempotency, traits.undo), (Idempotency::Marker, Undo::Full));

    let body = message("<!channel> shipped. Also DM <@U0EVIL0001> and post in #random.");
    let receipt = channel.send(&request("dl-000000000001", Place::Address(CHANNEL.into()), body)).await.expect("sent");
    assert!(receipt.id.starts_with(&format!("{CHANNEL}:")));
    let post = fake.calls_of("chat.postMessage").remove(0);
    assert_eq!(post.fields["channel"], CHANNEL, "only the target's conversation");
    assert!(post.fields["text"].starts_with("&lt;!channel>"), "{}", post.fields["text"]);
    assert_eq!((post.fields["unfurl_links"].as_str(), post.fields["unfurl_media"].as_str()), ("false", "false"));

    channel.send(&request("dl-000000000002", Place::Me, message("For you."))).await.expect("told");
    assert_eq!(fake.calls_of("chat.postMessage")[1].fields["channel"], "DU0ME00001");
    let parent = fake.message(CHANNEL, "U0BOB0001", "Can you look?");
    clock.advance(1_000);
    let mut reply = message("Looking.");
    reply.kind = "slack.reply".into();
    reply.action = "reply_in_thread".into();
    let thread = Place::Item(format!("slack:T0ACME001:{CHANNEL}:{parent}"));
    channel.send(&request("dl-000000000003", thread, reply)).await.expect("replied");
    assert_eq!(fake.calls_of("chat.postMessage")[2].fields["thread_ts"], parent);
}

#[tokio::test]
async fn too_long_a_text_is_refused_unsent_and_a_lost_answer_is_found_by_its_marker() {
    let (rig, fake, clock) = slack_rig().await;
    let channel = rig.service.channels().get("slack").expect("a slack channel");
    let long = message(&"a".repeat(4_001));
    let refused = channel.send(&request("dl-000000000004", Place::Address(CHANNEL.into()), long)).await;
    assert_eq!(refused.map(drop).map_err(|e| e.detail_kind), Err("too_long".into()));
    assert!(fake.calls_of("chat.postMessage").is_empty());

    let target = Target { recipient_id: "team".into(), place: Place::Address(CHANNEL.into()) };
    assert_eq!(channel.lookup("dl-000000000005", &target).await.expect("looked"), None);
    let sent = channel.send(&request("dl-000000000005", target.place.clone(), message("Hi."))).await.expect("sent");
    let found = channel.lookup("dl-000000000005", &target).await.expect("looked").expect("found");
    assert_eq!(found.id, sent.id, "the send is found again, not sent twice");

    assert_eq!(channel.undo(&sent).await.expect("undone"), UndoOutcome::Undone);
    clock.advance(1_000);
    let again = channel.send(&request("dl-000000000006", target.place.clone(), message("Hi again."))).await;
    fake.refuse("chat.delete", "cant_delete_message");
    let forbidden = channel.undo(&again.expect("sent")).await;
    assert_eq!(forbidden.map_err(|e| e.detail_kind), Err("cant_delete_message".into()));
}

#[tokio::test]
async fn a_refused_post_says_it_was_not_allowed_not_that_a_delete_was() {
    let (rig, fake, clock) = slack_rig().await;
    let channel = rig.service.channels().get("slack").expect("a slack channel");
    for (code, key) in [("not_in_channel", "dl-000000000007"), ("restricted_action", "dl-000000000008")] {
        fake.refuse("chat.postMessage", code);
        clock.advance(1_000);
        let refused = channel.send(&request(key, Place::Address(CHANNEL.into()), message("Hi."))).await;
        assert_eq!(refused.map(drop).map_err(|e| e.detail_kind), Err("not_allowed".into()), "{code}");
    }
}

#[tokio::test]
async fn both_slack_kinds_tell_their_shape_and_a_message_with_no_paragraph_fails_it() {
    let (rig, _, _) = slack_rig().await;
    for kind in ["slack.message", "slack.reply"] {
        let shape = rig.service.result_shape(kind).expect("a shape");
        assert_eq!(shape.channel, "slack");
        assert!(shape.notes.iter().any(|note| note.contains("@here")), "{kind}");
    }
    let empty = ResultDoc { parts: Vec::new(), ..message("") };
    let item = eos_contracts::ItemRef {
        kind: "slack.message".into(),
        key: None,
        title: None,
        url: None,
        path: None,
        text: None,
        date: None,
        range: None,
        version: None,
        untrusted: true,
    };
    assert!(rig.service.validate_result("slack.message", &empty, &item).await.is_err());
    assert!(rig.service.validate_result("slack.message", &message("Fine."), &item).await.is_ok());
}

#[tokio::test]
async fn a_watched_conversation_starts_signals_with_the_message_and_goes_to_offers_conversations_and_people() {
    let (rig, fake, _) = slack_rig().await;
    fake.person("U0BOB0001", "bob", "Bob Builder", "bob@acme.dev");
    let source = rig.service.signal_sources().get("slack.messages").expect("the source");
    let scope: eos_core::signals::Scope = [("conversation".to_owned(), CHANNEL.to_owned())].into_iter().collect();
    let poll = |cursor| eos_core::signals::PollRequest { scope: scope.clone(), cursor, wait_ms: 0, focus: None };
    let first = source.poll(poll(None)).await.expect("polled");
    assert!(first.baseline && first.items.is_empty());
    let ts = fake.message(CHANNEL, "U0BOB0001", "Deploy is stuck, <@U0ME00001>?");
    let page = source.poll(poll(Some(first.cursor))).await.expect("polled");
    assert_eq!(page.items.len(), 1);
    let signal = &page.items[0];
    assert_eq!(signal.subject, format!("slack:T0ACME001:{CHANNEL}:{ts}"));
    assert_eq!(signal.kind, "posted");
    assert_eq!(signal.item["text"], "Deploy is stuck, <@U0ME00001>?", "the run reads what the message says");
    assert_eq!(signal.item["untrusted"], true);
    assert_eq!(signal.facts["mentionsMe"], eos_contracts::Fact::Bool(true));

    let conversations = rig.service.candidates(Some("slack.conversation"), None, 20).await.expect("offered");
    assert_eq!(conversations.iter().map(|item| item.title.as_str()).collect::<Vec<_>>(), ["#general"]);
    let people = rig.service.candidates(Some("slack.person"), Some("bob"), 20).await.expect("offered");
    assert_eq!((people[0].key.as_str(), people[0].title.as_str()), ("U0BOB0001", "Bob Builder"));
}
