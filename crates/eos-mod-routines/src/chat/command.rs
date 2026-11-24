//! `/run <slug> [item…] [--note …] [--show-only]`: the user starts a routine
//! from a chat. Only the name of a live routine is taken; anything else (another
//! word, the agent's own `/run`) goes to the agent as typed. The run is the user's own start, so it runs as if
//! started from the form; the chat gets its card ([`super::tell`]).

use std::sync::Arc;

use eos_core::agent::AgentCapabilities;
use eos_core::routine::{NewRun, RunOrigin};
use eos_core::{BoxFuture, Error};
use eos_sessions::{CommandAnswer, SlashCommand, SlashContext};
use serde_json::json;

use super::{CHAT_DOOR, input, named, typed};
use crate::engine::{self, Engine};

pub(crate) struct RunCommand(pub(crate) Arc<Engine>);

/// What the user typed after `/run`.
#[derive(Debug, PartialEq, Eq)]
struct Typed {
    slug: String,
    item: Option<String>,
    note: Option<String>,
    show_only: bool,
}

fn slug_shaped(word: &str) -> bool {
    !word.is_empty() && word.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The words before the first flag are the item; `--note` takes the words
/// up to the next flag.
fn parse(args: &str) -> Option<Typed> {
    let mut words = args.split_whitespace();
    let slug = words.next().filter(|word| slug_shaped(word))?.to_owned();
    let (mut item, mut note, mut show_only) = (Vec::new(), Vec::new(), false);
    let mut in_note = false;
    for word in words {
        match word {
            "--show-only" => (show_only, in_note) = (true, false),
            "--note" => in_note = true,
            _ if in_note => note.push(word),
            _ => item.push(word),
        }
    }
    let joined = |words: Vec<&str>| (!words.is_empty()).then(|| words.join(" "));
    Some(Typed { slug, item: joined(item), note: joined(note), show_only })
}

impl SlashCommand for RunCommand {
    fn name(&self) -> &'static str {
        "run"
    }

    fn description(&self) -> &'static str {
        "Run a routine: /run <routine> [item] [--note …] [--show-only]"
    }

    fn accepts(&self, args: &str, _capabilities: &AgentCapabilities) -> bool {
        parse(args).is_some()
    }

    fn claims<'a>(&'a self, args: &'a str) -> BoxFuture<'a, Result<bool, Error>> {
        Box::pin(async move {
            let Some(typed_run) = parse(args) else { return Ok(false) };
            let (now, slug) = (self.0.clock.now_ms(), typed_run.slug);
            Ok(self.0.store.read(move |tx| named(tx, &slug, now)).await?.is_some())
        })
    }

    fn execute<'a>(&'a self, cx: SlashContext<'a>) -> BoxFuture<'a, Result<CommandAnswer, Error>> {
        Box::pin(async move {
            let Some(typed_run) = parse(cx.args) else {
                return Ok(CommandAnswer::new(400, json!({"ok": false, "error": "/run takes a routine's name"})));
            };
            let (now, slug) = (self.0.clock.now_ms(), typed_run.slug.clone());
            let Some(routine) = self.0.store.read(move |tx| named(tx, &slug, now)).await? else {
                let error = format!("No routine named {}", typed_run.slug);
                return Ok(CommandAnswer::new(404, json!({"ok": false, "error": error})));
            };
            // The user typed the item: it is theirs, not outside text.
            let item = typed(typed_run.item.as_deref()).map(|mut item| {
                item.untrusted = false;
                item
            });
            let new = NewRun {
                routine_id: routine.id.clone(),
                version: None,
                input: input(item, typed_run.note, typed_run.show_only, cx.worker_id),
                items: Vec::new(),
                origin: RunOrigin::Hand,
                door: Some(CHAT_DOOR.into()),
                confirm_repeat: false,
                client_request_id: None,
            };
            Ok(match engine::start_runs(&self.0, new).await {
                Ok(made) => {
                    let runs: Vec<_> =
                        made.iter().map(|run| json!({"id": run.id, "state": run.state.as_str()})).collect();
                    CommandAnswer::ok(json!({"ok": true, "routineId": routine.id, "runs": runs}))
                }
                Err(eos_core::routine::StartError::Store(error)) => return Err(error),
                Err(refused) => {
                    let (code, error) = crate::actions::refusal(refused);
                    CommandAnswer::new(409, json!({"ok": false, "error": error, "code": code}))
                }
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_item_note_and_show_only_are_read_from_what_was_typed() {
        assert_eq!(
            parse("pr-review 482 --note look at tests --show-only"),
            Some(Typed {
                slug: "pr-review".into(),
                item: Some("482".into()),
                note: Some("look at tests".into()),
                show_only: true,
            })
        );
        assert_eq!(parse("digest"), Some(Typed { slug: "digest".into(), item: None, note: None, show_only: false }));
    }

    #[test]
    fn only_a_slug_shaped_word_is_taken() {
        assert_eq!(parse(""), None);
        assert_eq!(
            parse("the tests again"),
            Some(Typed { slug: "the".into(), item: Some("tests again".into()), note: None, show_only: false })
        );
        assert_eq!(parse("Tests"), None);
        assert_eq!(parse("./build.sh"), None);
    }
}
