use serde_json::json;

use super::*;

/// Rows as the event log stores them (the recorded wire's payload shapes).
struct Log {
    rows: Vec<EventRecord>,
    ts: i64,
}

impl Log {
    fn new() -> Self {
        Self { rows: vec![], ts: 1_790_000_000_000 }
    }

    fn at(mut self, ts_step: i64, kind: &str, payload: Value) -> Self {
        self.ts += ts_step;
        let id = self.rows.len() as i64 + 1;
        self.rows.push(EventRecord {
            id,
            worker_id: "w-1".into(),
            ts: self.ts,
            kind: kind.into(),
            payload: Some(payload.to_string()),
        });
        self
    }

    fn user(self, text: &str) -> Self {
        self.at(1_000, "user_message", json!({"text": text, "msgId": "m-1", "clientMsgIds": ["c-1"]}))
    }

    fn reply(self, text: &str) -> Self {
        self.at(
            1_000,
            "agent_event",
            json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": text}]}),
        )
    }

    fn shell(self, call: &str, command: &str, is_error: bool) -> Self {
        self.at(500, "agent_event", json!({"type": "activity", "kind": "tool_started", "callId": call, "toolName": "Bash", "input": {"command": command}}))
            .at(500, "agent_event", json!({"type": "activity", "kind": "tool_finished", "callId": call, "result": "out", "isError": is_error}))
    }

    fn signals(&self) -> Vec<Signal> {
        scan(&self.rows, &[], &[]).into_iter().map(|m| m.signal).collect()
    }
}

#[test]
fn the_message_classifier_reads_english_and_turkish() {
    let table = [
        ("Always use pnpm in this repo", MessageClass::Rule),
        ("From now on use pnpm here", MessageClass::Rule),
        ("never push to main", MessageClass::Rule),
        ("In this repo we squash merges", MessageClass::Rule),
        ("No, always run the linter first", MessageClass::Rule),
        ("Use npm this time, it's always flaky", MessageClass::Neutral),
        ("Bundan sonra pnpm kullan", MessageClass::Rule),
        ("Her zaman Türkçe yaz", MessageClass::Rule),
        ("Bu seferlik asla deme", MessageClass::Neutral),
        ("No, that's the wrong file", MessageClass::Correction),
        ("That's not what I asked", MessageClass::Correction),
        ("you broke the build", MessageClass::Correction),
        ("Hayır, öyle değil", MessageClass::Correction),
        ("Yanlış dosyayı açtın", MessageClass::Correction),
        ("Nothing else, thanks", MessageClass::Neutral),
        ("Actually use the v2 endpoint", MessageClass::Unclear),
        ("Aslında v2 kullanmalısın", MessageClass::Unclear),
        ("Looks good, ship it", MessageClass::Neutral),
        (
            "Is there a known issue with the release notes of the third build of the client, and how long will the review take? It was wrong",
            MessageClass::Neutral,
        ),
    ];
    for (text, class) in table {
        assert_eq!(classify_user_message(text), class, "{text}");
    }
}

#[test]
fn a_correction_or_neutral_reply_counts_only_after_the_agent_spoke() {
    let log = Log::new()
        .user("No, start with the parser")
        .reply("ok")
        .user("No, use the old one")
        .reply("done")
        .user("thanks");
    assert_eq!(log.signals(), vec![Signal::SaysWrong, Signal::Accepted]);
    let rule = Log::new().user("always use pnpm");
    let moments = scan(&rule.rows, &[], &[]);
    assert_eq!(moments[0].signal, Signal::StatesRule);
    assert_eq!(moments[0].trust, Trust::Said);
}

#[test]
fn a_failed_command_and_a_failed_test_are_moments_and_probes_are_not() {
    let log = Log::new()
        .user("build it")
        .shell("c1", "npm run build", true)
        .shell("c2", "cargo test -p x", true)
        .shell("c3", "which pnpm", true)
        .shell("c4", "test -f a.txt", true)
        .shell("c5", "ls missing/", true)
        .shell("c6", "cd src && grep -r foo .", true)
        .shell("c7", "[ -d x ]", true)
        .shell("c8", "echo ok", false);
    assert_eq!(log.signals(), vec![Signal::CommandFails, Signal::TestFails]);
    let moments = scan(&log.rows, &[], &[]);
    assert!(moments[0].cues.contains(&Cue { kind: HookKind::Command, key: "npm run build".into() }));
    assert_eq!(moments[1].trust, Trust::Outcome);
}

#[test]
fn a_failure_the_policy_caused_is_no_command_failure() {
    let log = Log::new().user("go").at(100, "policy", json!({"tool": "Bash", "decision": "deny"})).shell(
        "c1",
        "rm -rf build",
        true,
    );
    assert_eq!(log.signals(), Vec::<Signal>::new());
}

#[test]
fn a_tool_result_in_a_message_block_counts_once() {
    let log = Log::new()
        .user("go")
        .at(100, "agent_event", json!({"type": "message", "role": "assistant", "blocks": [{"type": "tool_call", "callId": "c1", "name": "Bash", "input": {"command": "make"}}]}))
        .at(100, "agent_event", json!({"type": "message", "role": "tool", "blocks": [{"type": "tool_result", "callId": "c1", "isError": true, "content": "x"}]}))
        .at(100, "agent_event", json!({"type": "activity", "kind": "tool_finished", "callId": "c1", "isError": true}));
    assert_eq!(log.signals(), vec![Signal::CommandFails]);
}

#[test]
fn two_failures_then_success_in_one_turn_is_hard_won() {
    let log = Log::new()
        .user("lint it")
        .shell("c1", "npm run lint", true)
        .shell("c2", "npm run lint -- --fix", true)
        .shell("c3", "npm run lint", false);
    let moments = scan(&log.rows, &[], &[]);
    let signals: Vec<_> = moments.iter().map(|m| m.signal).collect();
    assert_eq!(signals, vec![Signal::CommandFails, Signal::CommandFails, Signal::HardWon]);
    assert_eq!((moments[2].row_from, moments[2].row_to), (3, 7));
    let new_turn = Log::new()
        .user("lint")
        .shell("c1", "npm run lint", true)
        .shell("c2", "npm run lint", true)
        .user("again")
        .shell("c3", "npm run lint", false);
    assert!(!new_turn.signals().contains(&Signal::HardWon), "a new message starts a new turn");
}

#[test]
fn a_stop_while_a_tool_runs_or_soon_after_output_is_a_moment_joined_by_the_next_message() {
    let started = json!({"type": "activity", "kind": "tool_started", "callId": "c1", "toolName": "Bash", "input": {"command": "rm -rf dist"}});
    let interrupt = json!({"state": "IDLE", "from": "WORKING", "reason": "interrupt"});
    let log = Log::new().user("clean").at(100, "agent_event", started).at(60_000, "state", interrupt.clone()).at(
        90_000,
        "user_message",
        json!({"text": "keep dist"}),
    );
    let moments = scan(&log.rows, &[], &[]);
    assert_eq!(moments[0].signal, Signal::Stops);
    assert_eq!((moments[0].row_from, moments[0].row_to), (3, 4));

    let late = Log::new().user("go").reply("working on it").at(31_000, "state", interrupt.clone());
    assert_eq!(late.signals(), Vec::<Signal>::new(), "a stop long after the output, no tool running");
    let soon = Log::new().user("go").reply("working on it").at(5_000, "state", interrupt).at(
        200_000,
        "user_message",
        json!({"text": "hm"}),
    );
    let moments = scan(&soon.rows, &[], &[]);
    assert_eq!(moments[0].signal, Signal::Stops);
    assert_eq!(moments[0].row_to, 3, "a message after two minutes does not join");
    let plain = Log::new().at(0, "state", json!({"state": "IDLE", "reason": "turn ended"}));
    assert_eq!(plain.signals(), Vec::<Signal>::new());
}

#[test]
fn undo_rows_denials_and_reactions_are_moments() {
    let log = Log::new()
        .at(0, "conversation_rewound", json!({}))
        .at(0, "message_recalled", json!({"text": "x"}))
        .at(0, "try_discarded", json!({}))
        .at(0, "try_kept", json!({}))
        .at(0, "permission_ttl_deny", json!({}));
    let denials = [Denial { row: 40, tool: "Bash".into() }];
    let reactions = [Reaction { row: 50, thumbs_up: false }, Reaction { row: 51, thumbs_up: true }];
    let signals: Vec<_> = scan(&log.rows, &denials, &reactions).into_iter().map(|m| m.signal).collect();
    assert_eq!(
        signals,
        vec![
            Signal::Undoes,
            Signal::Undoes,
            Signal::Undoes,
            Signal::Accepted,
            Signal::Denies,
            Signal::ThumbsDown,
            Signal::Accepted
        ]
    );
}

#[test]
fn a_repeated_request_within_three_messages_is_a_moment() {
    let log = Log::new()
        .user("rename the login button to sign in")
        .reply("done")
        .user("please rename the login button to sign in");
    let moments = scan(&log.rows, &[], &[]);
    let repeat = moments.iter().find(|m| m.signal == Signal::Repeats).expect("a repeat");
    assert_eq!((repeat.row_from, repeat.row_to), (1, 3));
    let far = Log::new().user("rename the login button").user("a").user("b").user("c").user("rename the login button");
    assert!(!far.signals().contains(&Signal::Repeats));
}

#[test]
fn a_subagents_failure_is_marked() {
    let log = Log::new()
        .user("go")
        .at(100, "agent_event", json!({"type": "activity", "kind": "tool_started", "callId": "s1", "toolName": "Bash", "input": {"command": "make"}, "parentCallId": "t1"}))
        .at(100, "agent_event", json!({"type": "activity", "kind": "tool_finished", "callId": "s1", "isError": true, "parentCallId": "t1"}));
    let moments = scan(&log.rows, &[], &[]);
    assert!(moments[0].subagent);
}

#[test]
fn probes_and_test_runners_are_known() {
    assert!(is_probe("which pnpm"));
    assert!(is_probe("cd x && /usr/bin/stat file"));
    assert!(!is_probe("make test"));
    assert!(is_test_run("cd ui && pnpm test --run"));
    assert!(is_test_run("xcodebuild test -scheme App"));
    assert!(!is_test_run("cargo build"));
    assert!((word_similarity("aa bb cc", "bb cc dd") - 0.5).abs() < 1e-9);
}

#[test]
fn a_code_view_stop_and_refusal_read_from_the_transcripts_rows() {
    let call = json!({"type": "message", "role": "assistant", "blocks": [{"type": "tool_call", "callId": "t1", "name": "Bash", "input": {"command": "git push --force"}}]});
    let refused = json!({"type": "message", "role": "tool", "blocks": [{"type": "tool_result", "callId": "t1", "isError": true, "content": "The user doesn't want to proceed with this tool use. The tool use was rejected"}]});
    let log = Log::new().user("ship it").at(500, "agent_event", call.clone()).at(500, "agent_event", refused);
    let moments = scan(&log.rows, &[], &[]);
    assert_eq!(moments.iter().map(|m| m.signal).collect::<Vec<_>>(), vec![Signal::Denies], "no command failure");
    assert_eq!(moments[0].cues, vec![Cue { kind: HookKind::Tool, key: "Bash".into() }]);

    let aborted = Log::new().user("go").at(500, "agent_event", call).at(
        2_000,
        "agent_event",
        json!({"type": "turn", "phase": "aborted"}),
    );
    assert_eq!(aborted.signals(), vec![Signal::Stops], "a stop while the call runs");
}

#[test]
fn a_stated_rule_holds_everywhere_only_when_it_says_so() {
    assert!(says_everywhere("Always use pnpm, everywhere"));
    assert!(says_everywhere("Bundan sonra her yerde pnpm kullan"));
    assert!(!says_everywhere("Always use pnpm here"));
}
