//! The feature's pure rules against the TypeScript: every case in
//! `tests/fixtures/terminal-vectors.json` (frozen from the TypeScript, see `rust/fixtures/README.md`) must give what
//! the TypeScript gave.

use eos_contracts::PtyQuestionAnswer;
use eos_testkit::FakeTerminals;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::keys::{QuestionShape, answer_steps, approve_plan_steps, is_shell_process, prompt_steps, step_gap};
use crate::launch::claude_command;
use crate::osc::{OscEvent, OscScanner};
use crate::runs::strip_ansi;

#[derive(Deserialize)]
struct Fixture {
    launch: Vec<Launch>,
    osc: Vec<OscCase>,
    keys: Keys,
    ansi: Vec<Ansi>,
}

#[derive(Deserialize)]
struct Launch {
    resume: Option<String>,
    id: String,
    command: String,
}

#[derive(Deserialize)]
struct OscCase {
    chunks: Vec<String>,
    events: Vec<Vec<Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Keys {
    prompts: Vec<Prompt>,
    approve_plan: Vec<String>,
    gaps: Vec<Gap>,
    shells: Vec<Shell>,
    answers: Vec<Answer>,
}

#[derive(Deserialize)]
struct Prompt {
    text: String,
    steps: Vec<String>,
}

#[derive(Deserialize)]
struct Gap {
    step: String,
    ms: u64,
}

#[derive(Deserialize)]
struct Shell {
    name: String,
    shell: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Question {
    multi_select: bool,
    option_count: usize,
}

#[derive(Deserialize)]
struct Answer {
    questions: Vec<Question>,
    answers: Vec<PtyQuestionAnswer>,
    steps: Option<Vec<String>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Ansi {
    input: String,
    output: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../tests/fixtures/terminal-vectors.json")).expect("vectors")
}

#[test]
fn claude_is_launched_with_todays_command_line() {
    let terminals = FakeTerminals::new();
    for case in fixture().launch {
        let command = claude_command(&terminals, "claude", &case.id, case.resume.is_some());
        assert_eq!(command, case.command, "resume: {:?}", case.resume);
    }
    // A Claude the shell does not find itself is run by its path.
    let by_path = claude_command(&terminals, "/Users/me/it's here/claude", "id-1", false);
    assert!(by_path.starts_with(r"EOS_TTY=$(tty) '/Users/me/it'\''s here/claude' --model opus "), "{by_path}");
}

fn event_json(event: OscEvent) -> Value {
    match event {
        OscEvent::Title(title) => json!({ "kind": "title", "title": title }),
        OscEvent::ClaudeSession(id) => json!({ "kind": "claudeSession", "id": id }),
        OscEvent::DialogTool(call) => json!({ "kind": "dialogTool", "call": call }),
    }
}

#[test]
fn a_panes_reports_are_read_as_today() {
    for (n, case) in fixture().osc.into_iter().enumerate() {
        let mut scanner = OscScanner::default();
        for (chunk, expected) in case.chunks.iter().zip(&case.events) {
            let got: Vec<Value> = scanner.scan(chunk).into_iter().map(event_json).collect();
            assert_eq!(&got, expected, "session {n}, after {chunk:?}");
        }
    }
}

#[test]
fn the_keys_that_drive_claude_are_todays() {
    let keys = fixture().keys;
    for prompt in keys.prompts {
        assert_eq!(prompt_steps(&prompt.text), prompt.steps);
    }
    assert_eq!(approve_plan_steps(), keys.approve_plan);
    for gap in keys.gaps {
        assert_eq!(step_gap(&gap.step).as_millis(), u128::from(gap.ms), "{:?}", gap.step);
    }
    for shell in keys.shells {
        assert_eq!(is_shell_process(&shell.name), shell.shell, "{:?}", shell.name);
    }
    for (n, case) in keys.answers.into_iter().enumerate() {
        let questions: Vec<QuestionShape> = case
            .questions
            .iter()
            .map(|q| QuestionShape { multi_select: q.multi_select, option_count: q.option_count })
            .collect();
        match answer_steps(&questions, &case.answers) {
            Ok(steps) => assert_eq!(Some(steps), case.steps, "case {n}"),
            Err(e) => assert_eq!(Some(e.0), case.error, "case {n}"),
        }
    }
}

#[test]
fn escape_sequences_are_stripped_from_command_output_as_today() {
    for case in fixture().ansi {
        assert_eq!(strip_ansi(&case.input), case.output, "{:?}", case.input);
    }
}
