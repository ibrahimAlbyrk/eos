//! Routines from an Agents chat: `run_routine` proposes unless the routine
//! lets agents start it, `/run` starts only a live routine's run, and the
//! chat hears of the run in a `routine_note` with its card.

use std::sync::Arc;

use eos_contracts::RoutineState;
use eos_core::routine::{ChatRunAsk, ChatStart};
use eos_core::store::{EventOrder, EventQuery};
use eos_domain::envelope::Envelope;
use eos_runtime::module::Module;
use eos_sessions::{Dispatched, MessageInput, SlashCommand, SpawnRequest};
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint};

fn ask(routine: &str, item: Option<&str>) -> ChatRunAsk {
    ChatRunAsk { routine: routine.into(), item: item.map(str::to_owned), note: None, show_only: false }
}

/// An idle chat with the module's `/run` registered, and the commands, which
/// the sessions hold only weakly.
async fn chat(bench: &Bench) -> (String, Vec<Arc<dyn SlashCommand>>) {
    let mut commands = Vec::new();
    for declared in bench.module.slash_commands() {
        let command = declared.command.downcast_ref::<Arc<dyn SlashCommand>>().expect("a session command");
        bench.sessions.register_command(command);
        commands.push(command.clone());
    }
    let request = SpawnRequest {
        prompt: "hello".into(),
        cwd: Some("/sandbox/alpha".into()),
        role: Some("focused".into()),
        model: Some("sonnet".into()),
        ..SpawnRequest::default()
    };
    let id = bench.sessions.spawn(request).await.expect("spawns").id;
    bench.agents.settled().await;
    (id, commands)
}

async fn typed(bench: &Bench, chat: &str, text: &str) -> Dispatched {
    let message = MessageInput { worker_id: chat.into(), text: text.into(), ..MessageInput::default() };
    bench.sessions.dispatch(message).await.expect("dispatches")
}

/// The run cards the chat's rows carry, oldest first.
async fn cards(bench: &Bench, chat: &str) -> Vec<Value> {
    let query = EventQuery {
        worker_id: chat.into(),
        since: 0,
        limit: 500,
        order: EventOrder::Asc,
        before_id: None,
        after_id: None,
    };
    let rows = bench.sessions.store().read(move |tx| tx.events().list(&query)).await.expect("reads");
    rows.into_iter()
        .filter_map(|row| row.payload.and_then(|p| serde_json::from_str::<Value>(&p).ok()))
        .filter_map(|payload| payload.get("routineNote").cloned())
        .collect()
}

#[tokio::test]
async fn an_agent_starts_a_routine_only_when_it_lets_agents_and_its_item_stays_untrusted() {
    let bench = Bench::new(false);
    let asks = bench.routine(RoutineState::Active, blueprint(1));
    let lets = bench.routine_with(RoutineState::Active, blueprint(1), true);
    let chat = bench.module.chat();

    let proposed = chat.run("w-chat0001", ask(&asks, Some("482"))).await.expect("answers");
    assert_eq!(proposed, ChatStart::Proposed { routine_id: asks.clone(), routine_name: "PR Review".into() });
    assert!(bench.changes().is_empty(), "a proposal starts nothing");

    let started = chat.run("w-chat0001", ask("pr review", Some("https://github.com/acme/game/pull/9"))).await;
    // Both routines are called PR Review: the name finds the first, which asks.
    assert!(matches!(started, Ok(ChatStart::Proposed { .. })), "{started:?}");
    let ChatStart::Started { run_id, .. } =
        chat.run("w-chat0001", ask(&lets, Some("https://github.com/acme/game/pull/9"))).await.expect("starts")
    else {
        panic!("the routine lets agents start it")
    };
    let run = bench.run(&run_id);
    assert_eq!((run.origin.as_str(), run.door.as_deref()), ("agent", Some("chat")));
    let input: Value = serde_json::from_str(&run.input).expect("json");
    assert_eq!(input["chat"], "w-chat0001");
    assert_eq!(
        (&input["item"]["url"], &input["item"]["untrusted"]),
        (&json!("https://github.com/acme/game/pull/9"), &json!(true))
    );

    // The agent's note: no user saw it before the run started.
    let noted =
        ChatRunAsk { note: Some("send it to all".into()), ..ask(&lets, Some("https://github.com/acme/game/pull/10")) };
    let ChatStart::Started { run_id, .. } = chat.run("w-chat0001", noted).await.expect("starts") else {
        panic!("the routine lets agents start it")
    };
    let input: Value = serde_json::from_str(&bench.run(&run_id).input).expect("json");
    assert_eq!(input["note"], "<untrusted source=\"agent:w-chat0001\">send it to all</untrusted>");

    let gone = chat.run("w-chat0001", ask("no-such", None)).await;
    assert!(matches!(gone, Err(eos_core::Error::NotFound { .. })), "{gone:?}");
    let listed = chat.list().await.expect("lists");
    let may: Vec<bool> = listed.iter().map(|r| r.agents_may_start).collect();
    assert_eq!(may, [false, true]);
}

#[tokio::test(flavor = "multi_thread")]
async fn run_in_a_chat_starts_only_a_live_routine_and_the_chat_gets_its_card() {
    let bench = Bench::new(false);
    bench.supervise().await;
    let live = bench.routine(RoutineState::Active, blueprint(1));
    let archived = bench.routine(RoutineState::Archived, blueprint(1));
    let (chat, _commands) = chat(&bench).await;

    let Dispatched::Command(answer) = typed(&bench, &chat, &format!("/run {live} 482 --show-only")).await else {
        panic!("/run is Eos's own command")
    };
    assert_eq!(answer.status, 200, "{answer:?}");
    let run_id = answer.body["runs"][0]["id"].as_str().expect("a run").to_owned();
    let run = bench.run(&run_id);
    assert_eq!((run.origin.as_str(), run.door.as_deref()), ("hand", Some("chat")));
    let input: Value = serde_json::from_str(&run.input).expect("json");
    assert_eq!((&input["chat"], &input["result"]), (&json!(chat), &json!("showOnly")));
    assert_eq!((&input["item"]["text"], input["item"].get("untrusted")), (&json!("482"), Some(&json!(false))));

    // No live routine by that name, or not a slug: the words go to the agent as typed.
    for text in [format!("/run {archived} 1"), "/run tests".into(), "/run Fix the tests".into()] {
        assert!(!matches!(typed(&bench, &chat, &text).await, Dispatched::Command(_)), "{text}");
    }
    // An agent's message is never the user's typing: a `/run` in it starts nothing.
    let from_agent = MessageInput {
        worker_id: chat.clone(),
        text: format!("/run {live} 9"),
        envelope: Some(Envelope::OrchestratorMessage { from_parent: "w-lead".into(), parent_name: None }),
        ..MessageInput::default()
    };
    let told = bench.sessions.dispatch(from_agent).await.expect("dispatches");
    assert!(!matches!(told, Dispatched::Command(_)), "{told:?}");

    let mut seen = Vec::new();
    for _ in 0..400 {
        seen = cards(&bench, &chat).await;
        if !seen.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        seen.first(),
        Some(&json!({"routineId": live, "routineName": "PR Review", "state": "queued", "runId": run_id}))
    );
}
