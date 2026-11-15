//! Emoji reactions over the real store and a scripted runtime: which
//! reaction starts a turn, which waits for the user's next message, and what
//! the agent reads of them.

use std::sync::Arc;

use eos_contracts::{Reaction, ReactionActor, UnknownRecord, WorkerState};
use eos_core::Error;
use eos_core::agent::{AgentReactions, ReactTarget};
use eos_core::store::{EventOrder, EventQuery};
use eos_sessions::{MessageInput, NoHooks, REACTION_SETTLE_MS, SessionDeps, Sessions, SpawnRequest};
use eos_testkit::agent::events;
use eos_testkit::{
    FakeClock, FakeConfig, FakeModelCatalog, FakePrompts, FakeRecents, FakeSleeper, FakeWorktrees, ScriptedRuntime,
    SeqIds, TempStore, Turn,
};
use serde_json::Value;

struct Bench {
    sessions: Sessions,
    agents: ScriptedRuntime,
    temp: TempStore,
    sleeper: Arc<FakeSleeper>,
}

impl Bench {
    fn new() -> Self {
        let temp = TempStore::new();
        let agents = ScriptedRuntime::new();
        let sleeper = Arc::new(FakeSleeper::default());
        let sessions = Sessions::new(SessionDeps {
            store: temp.port(),
            runtime: agents.port(),
            clock: Arc::new(FakeClock::new()),
            ids: Arc::new(SeqIds::new()),
            config: Arc::new(FakeConfig::new(serde_json::json!({}))),
            models: Arc::new(FakeModelCatalog::default()),
            prompts: Arc::new(FakePrompts::default()),
            worktrees: Arc::new(FakeWorktrees::default()),
            recents: Arc::new(FakeRecents::default()),
            hooks: Arc::new(NoHooks),
            sleeper: sleeper.clone(),
        });
        Self { sessions, agents, temp, sleeper }
    }

    /// A chat of the given role whose agent answered its first prompt with `answer`.
    async fn chat_as(&self, role: Option<&str>, answer: &str) -> String {
        self.agents.script(Turn::reply(answer));
        let request = SpawnRequest {
            prompt: "hello".into(),
            cwd: Some("/sandbox/alpha".into()),
            role: role.map(str::to_owned),
            ..SpawnRequest::default()
        };
        let id = self.sessions.spawn(request).await.expect("spawns").id;
        self.agents.settled().await;
        self.idle(&id).await;
        id
    }

    async fn chat(&self, answer: &str) -> String {
        self.chat_as(Some("focused"), answer).await
    }

    /// The user says `text`, the agent answers `answer`.
    async fn exchange(&self, id: &str, text: &str, answer: &str) {
        self.agents.script(Turn::reply(answer));
        let input = MessageInput { worker_id: id.into(), text: text.into(), ..MessageInput::default() };
        self.sessions.dispatch(input).await.expect("delivers");
        self.agents.settled().await;
        self.idle(id).await;
    }

    async fn state(&self, id: &str) -> WorkerState {
        let id = id.to_owned();
        let worker = self.temp.port().read(move |tx| tx.workers().find(&id)).await.expect("reads");
        worker.expect("the row").state
    }

    async fn idle(&self, id: &str) {
        until(|| async { self.state(id).await == WorkerState::Idle }).await;
    }

    /// The worker's log: `(id, type, payload)` oldest first.
    async fn rows(&self, id: &str) -> Vec<(i64, String, Value)> {
        let query = EventQuery {
            worker_id: id.into(),
            since: 0,
            limit: 5000,
            order: EventOrder::Asc,
            before_id: None,
            after_id: None,
        };
        let rows = self.temp.port().read(move |tx| tx.events().list(&query)).await.expect("reads");
        rows.into_iter()
            .map(|r| (r.id, r.kind, r.payload.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or(Value::Null)))
            .collect()
    }

    /// The row of the newest message that says `text`.
    async fn row_saying(&self, id: &str, text: &str) -> i64 {
        let rows = self.rows(id).await;
        let said = |p: &Value| p["text"] == text || p["blocks"][0]["text"] == text;
        rows.iter().rev().find(|(_, _, p)| said(p)).map(|(row, ..)| *row).expect("a message that says it")
    }

    async fn reactions(&self, id: &str) -> Vec<Reaction> {
        self.sessions.reactions(id, 0, i64::MAX, 100).await.expect("lists")
    }

    /// Ends the wait of the `timers` reaction timers that are running: one per change the user made.
    async fn settle_reactions(&self, timers: usize) {
        let running = || self.sleeper.pending().iter().filter(|ms| **ms == REACTION_SETTLE_MS).count();
        until(|| async { running() == timers }).await;
        for left in (0..timers).rev() {
            assert!(self.sleeper.wake());
            until(|| async { running() == left }).await;
        }
    }

    /// The reaction turns the agent was sent so far.
    fn reaction_turns(&self, id: &str) -> Vec<String> {
        self.agents.sent(id).into_iter().filter(|text| text.starts_with("<reaction")).collect()
    }
}

/// A turn in which the agent says nothing: it only ends its turn.
fn silent() -> Turn {
    Turn::of(vec![
        events::tool_call("toolu_quiet", "mcp__worker__no_reply", UnknownRecord::default()),
        events::tool_result("toolu_quiet", "Turn ended without a reply.", false),
    ])
}

async fn until<F: std::future::Future<Output = bool>>(done: impl Fn() -> F) {
    for _ in 0..5_000 {
        if done().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    panic!("waited too long");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reaction_on_the_agents_question_starts_a_turn_the_agent_may_end_in_silence() {
    let bench = Bench::new();
    let id = bench.chat("Delete the old branch too?").await;
    let asked = bench.row_saying(&id, "Delete the old branch too?").await;
    let before = bench.rows(&id).await.len();

    let set = bench.sessions.react_as_user(&id, asked, " 👍 ").await.expect("reacts");
    assert_eq!(set.wakes_in_ms, Some(REACTION_SETTLE_MS), "the agent waits for exactly this answer");
    let mine = Reaction {
        row_id: asked,
        actor: ReactionActor::User,
        emoji: "👍".into(),
        at: set.reaction.at,
        seen: Some(false),
    };
    assert_eq!(set.reaction, mine);
    assert!(bench.reaction_turns(&id).is_empty(), "the user may still change their mind");

    bench.agents.script(silent());
    bench.settle_reactions(1).await;
    until(|| async { bench.reaction_turns(&id).len() == 1 }).await;
    assert_eq!(
        bench.reaction_turns(&id),
        ["<reaction emoji=\"👍\" on=\"yours\">Delete the old branch too?</reaction>"],
        "the turn is the reaction and nothing else: no message id, no bubble"
    );
    bench.agents.settled().await;
    bench.idle(&id).await;

    let rows = bench.rows(&id).await;
    let added: Vec<&str> = rows[before..].iter().map(|(_, kind, _)| kind.as_str()).collect();
    assert!(!added.contains(&"user_message"), "the chat got no message of the user's: {added:?}");
    assert!(rows[before..].iter().any(|(_, kind, p)| kind == "state" && p["reason"] == "reaction"), "{added:?}");
    assert_eq!(bench.reactions(&id).await, [Reaction { seen: Some(true), ..mine }], "the agent has seen it");
    let seen: Vec<String> = bench
        .temp
        .announced
        .list()
        .into_iter()
        .filter(|(topic, _)| *topic == "reactions:change")
        .map(|(_, payload)| payload)
        .collect();
    assert_eq!(seen.len(), 2, "set, then seen: {seen:?}");
    assert!(seen[0].contains("\"seen\":false") && seen[1].contains("\"seen\":true"), "{seen:?}");

    // Nothing is told twice.
    bench.exchange(&id, "thanks", "Any time.").await;
    assert_eq!(bench.agents.sent(&id).last().map(String::as_str), Some("<msg id=\"2\"/>\nthanks"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_last_state_of_a_reaction_is_told_and_one_taken_back_in_time_is_never_told() {
    let bench = Bench::new();
    let id = bench.chat("Ship it today?").await;
    let asked = bench.row_saying(&id, "Ship it today?").await;

    bench.sessions.react_as_user(&id, asked, "👍").await.expect("reacts");
    bench.sessions.react_as_user(&id, asked, "👎").await.expect("changes it");
    bench.agents.script(Turn::reply("Then tomorrow."));
    bench.settle_reactions(2).await;
    until(|| async { bench.reaction_turns(&id).len() == 1 }).await;
    assert_eq!(bench.reaction_turns(&id), ["<reaction emoji=\"👎\" on=\"yours\">Ship it today?</reaction>"]);
    bench.agents.settled().await;
    bench.idle(&id).await;

    // On the agent's new latest message: set and taken back before the timer ends.
    let said = bench.row_saying(&id, "Then tomorrow.").await;
    bench.sessions.react_as_user(&id, said, "👌").await.expect("reacts");
    assert!(bench.sessions.unreact_as_user(&id, said).await.expect("takes it back"));
    assert!(!bench.sessions.unreact_as_user(&id, said).await.expect("nothing left"), "there was none");
    bench.settle_reactions(2).await;
    assert_eq!(bench.reaction_turns(&id).len(), 1, "nothing was sent for it");
    assert_eq!(bench.reactions(&id).await.len(), 1, "only the 👎 is left");
    assert_eq!(bench.temp.count("SELECT COUNT(*) FROM message_reactions"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reaction_anywhere_else_goes_with_the_users_next_message() {
    let bench = Bench::new();
    let id = bench.chat("First answer.").await;
    bench.exchange(&id, "note this", "Noted.").await;
    let (old, own) = (bench.row_saying(&id, "First answer.").await, bench.row_saying(&id, "note this").await);

    let on_old = bench.sessions.react_as_user(&id, old, "❤️").await.expect("reacts");
    let on_own = bench.sessions.react_as_user(&id, own, "📌").await.expect("reacts");
    assert_eq!((on_old.wakes_in_ms, on_own.wakes_in_ms), (None, None), "neither is on the agent's latest message");
    bench.settle_reactions(2).await;
    assert!(bench.reaction_turns(&id).is_empty());

    bench.exchange(&id, "go on", "Going on.").await;
    assert_eq!(
        bench.agents.sent(&id).last().map(String::as_str),
        Some(
            "<msg id=\"3\"/>\n<reaction emoji=\"❤️\" on=\"yours\">First answer.</reaction>\n<reaction emoji=\"📌\" on=\"theirs\" id=\"2\"/>\ngo on"
        )
    );
    assert!(bench.reactions(&id).await.iter().all(|r| r.seen == Some(true)));
    let shown = bench.row_saying(&id, "go on").await;
    assert!(shown > own, "the chat shows what the user typed, without the reactions");

    // One taken back after the agent heard of it is told as taken back.
    bench.sessions.unreact_as_user(&id, own).await.expect("takes it back");
    bench.exchange(&id, "and now", "Now.").await;
    assert_eq!(
        bench.agents.sent(&id).last().map(String::as_str),
        Some("<msg id=\"4\"/>\n<reaction emoji=\"📌\" removed=\"true\" on=\"theirs\" id=\"2\"/>\nand now")
    );
    assert_eq!(bench.temp.count("SELECT COUNT(*) FROM message_reactions"), 1, "its row went once it was told");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_agent_is_never_interrupted_and_hears_of_it_when_it_goes_idle() {
    let bench = Bench::new();
    let id = bench.chat("Ready.").await;
    let release = bench.agents.script_held(Turn::reply("Run the migration as well?"));
    let input = MessageInput { worker_id: id.clone(), text: "start".into(), ..MessageInput::default() };
    bench.sessions.dispatch(input).await.expect("delivers");
    until(|| async {
        bench.rows(&id).await.iter().any(|(.., p)| p["blocks"][0]["text"] == "Run the migration as well?")
    })
    .await;
    let asked = bench.row_saying(&id, "Run the migration as well?").await;

    let set = bench.sessions.react_as_user(&id, asked, "👍").await.expect("reacts");
    assert_eq!(set.wakes_in_ms, None, "the agent is in a turn");
    bench.settle_reactions(1).await;
    assert!(bench.reaction_turns(&id).is_empty(), "a turn is never interrupted for a reaction");

    bench.agents.script(silent());
    release.release();
    until(|| async { bench.reaction_turns(&id).len() == 1 }).await;
    bench.agents.settled().await;
    bench.idle(&id).await;
    assert_eq!(bench.reactions(&id).await[0].seen, Some(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_agents_latest_message_is_what_it_said_last_however_many_pieces() {
    let bench = Bench::new();
    let id = bench.chat("Ready.").await;
    // Said, a tool, then the answer in two pieces: the chat shows the two as one message.
    bench.agents.script(Turn::of(vec![
        events::text("Let me look.", "m1:0"),
        events::tool_call("toolu_1", "Read", UnknownRecord::default()),
        events::tool_result("toolu_1", "data", false),
        events::text("Found it.", "m2:0"),
        events::text("Fix it now?", "m2:1"),
    ]));
    let input = MessageInput { worker_id: id.clone(), text: "check".into(), ..MessageInput::default() };
    bench.sessions.dispatch(input).await.expect("delivers");
    bench.agents.settled().await;
    bench.idle(&id).await;
    let (before_tool, first_piece) =
        (bench.row_saying(&id, "Let me look.").await, bench.row_saying(&id, "Found it.").await);

    let earlier = bench.sessions.react_as_user(&id, before_tool, "👀").await.expect("reacts");
    assert_eq!(earlier.wakes_in_ms, None, "what it said before the tool is not its latest message");
    let latest = bench.sessions.react_as_user(&id, first_piece, "👍").await.expect("reacts");
    assert_eq!(latest.wakes_in_ms, Some(REACTION_SETTLE_MS), "the first piece is the row the chat reacts on");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_at_rest_comes_back_for_a_reaction_as_for_a_message() {
    let bench = Bench::new();
    let id = bench.chat("Merge it?").await;
    let asked = bench.row_saying(&id, "Merge it?").await;
    bench.agents.crash(&id).await;
    until(|| async { bench.state(&id).await == WorkerState::Suspended }).await;

    let set = bench.sessions.react_as_user(&id, asked, "👍").await.expect("reacts");
    assert_eq!(set.wakes_in_ms, Some(REACTION_SETTLE_MS));
    bench.agents.script(Turn::reply("Merged."));
    bench.settle_reactions(1).await;
    until(|| async { bench.reaction_turns(&id).len() == 1 }).await;
    assert_eq!(bench.agents.started().len(), 2, "its session was brought back");
    bench.agents.settled().await;
    bench.idle(&id).await;
    assert_eq!(bench.reaction_turns(&id).len(), 1, "told once, whoever noticed first");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn toggling_one_message_stops_starting_turns() {
    let bench = Bench::new();
    let id = bench.chat("Okay?").await;
    let asked = bench.row_saying(&id, "Okay?").await;
    for (n, emoji) in ["👍", "👎", "👍", "👎"].into_iter().enumerate() {
        let set = bench.sessions.react_as_user(&id, asked, emoji).await.expect("reacts");
        assert_eq!(set.wakes_in_ms.is_some(), n < 3, "change {n}");
        bench.agents.script(silent());
        bench.settle_reactions(1).await;
        if n < 3 {
            until(|| async { bench.reaction_turns(&id).len() == n + 1 }).await;
            bench.agents.settled().await;
            bench.idle(&id).await;
        }
    }
    assert_eq!(bench.reaction_turns(&id).len(), 3, "the fourth waits for the user's next message");
    assert_eq!(bench.reaction_turns(&id)[1], "<reaction emoji=\"👎\" was=\"👍\" on=\"yours\">Okay?</reaction>");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_messages_of_a_chat_the_user_talks_to_take_a_reaction() {
    let bench = Bench::new();
    let id = bench.chat("Hi.").await;
    let said = bench.row_saying(&id, "Hi.").await;
    let state_row =
        bench.rows(&id).await.iter().find(|(_, kind, _)| kind == "state").map(|(row, ..)| *row).expect("one");
    let react = |row, emoji: &'static str| bench.sessions.react_as_user(&id, row, emoji);
    assert!(matches!(react(said, "ok").await, Err(Error::Validation(_))), "one emoji");
    assert!(matches!(react(said, "👍👍").await, Err(Error::Validation(_))));
    assert!(matches!(react(9_999, "👍").await, Err(Error::NotFound { .. })), "no such message");
    assert!(matches!(react(state_row, "👍").await, Err(Error::Conflict(_))), "not a message");
    assert!(matches!(bench.sessions.react_as_user("w-nope", said, "👍").await, Err(Error::NotFound { .. })));

    let worker = bench.chat_as(None, "Done.").await;
    let done = bench.row_saying(&worker, "Done.").await;
    let refused = bench.sessions.react_as_user(&worker, done, "👍").await;
    assert!(matches!(refused, Err(Error::Conflict(_))), "a worker answers to its orchestrator: {refused:?}");
    assert!(bench.reactions(&id).await.is_empty() && bench.sleeper.pending().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_agent_reacts_to_the_users_messages_only() {
    let bench = Bench::new();
    let id = bench.chat("Hi.").await;
    let none = bench.sessions.react(&id, ReactTarget::Latest, Some("❤️")).await;
    assert!(matches!(none, Err(Error::NotFound { .. })), "the user has sent no message yet: {none:?}");
    bench.exchange(&id, "thanks a lot", "Sure.").await;
    bench.exchange(&id, "one more thing", "Yes?").await;
    let (first, latest) = (bench.row_saying(&id, "thanks a lot").await, bench.row_saying(&id, "one more thing").await);

    let reacted = bench.sessions.react(&id, ReactTarget::Latest, Some("👀")).await.expect("reacts");
    assert_eq!(reacted.excerpt, "one more thing");
    bench.sessions.react(&id, ReactTarget::Message(2), Some("❤️")).await.expect("reacts by id");
    bench.sessions.react(&id, ReactTarget::Message(2), Some("🎉")).await.expect("replaces its own");
    let theirs =
        |row_id, emoji: &str, at| Reaction { row_id, actor: ReactionActor::Agent, emoji: emoji.into(), at, seen: None };
    let listed = bench.reactions(&id).await;
    assert_eq!(listed, [theirs(first, "🎉", listed[0].at), theirs(latest, "👀", listed[1].at)]);
    assert!(bench.sleeper.pending().is_empty(), "the agent's own reactions start nothing");

    assert!(matches!(
        bench.sessions.react(&id, ReactTarget::Message(77), Some("👍")).await,
        Err(Error::NotFound { .. })
    ));
    assert!(matches!(bench.sessions.react(&id, ReactTarget::Latest, Some("fine")).await, Err(Error::Validation(_))));
    bench.sessions.react(&id, ReactTarget::Latest, None).await.expect("takes it back");
    assert_eq!(bench.reactions(&id).await.len(), 1);

    // Both sides on one message, the user's first.
    bench.sessions.react_as_user(&id, first, "👍").await.expect("the user reacts too");
    let both: Vec<ReactionActor> = bench.reactions(&id).await.iter().map(|r| r.actor).collect();
    assert_eq!(both, [ReactionActor::User, ReactionActor::Agent]);
}
