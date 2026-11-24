//! Routines from an Agents chat (01 §7): the agent lists them
//! (`list_routines`) and asks for a run (`run_routine`), which starts only
//! when the routine lets agents start it and is otherwise proposed to the
//! user; the user types `/run` ([`command`]). The chat a run was started
//! from hears of it in a `routine_note` ([`tell`]).

mod command;
mod tell;

pub(crate) use command::RunCommand;
pub(crate) use tell::hear as tell_chats;

use std::sync::Arc;

use eos_contracts::{ItemRef, ResultMode, RoutineState, RunInput};
use eos_core::routine::{ChatRoutine, ChatRoutines, ChatRunAsk, ChatStart, NewRun, RunOrigin, StartError};
use eos_core::store::{StoredRoutine, Tx};
use eos_core::{BoxFuture, Error};
use eos_domain::routine::item;

use crate::engine::{self, Engine};
use crate::routes::{BUILTIN, gone, summary};

/// What a run started from a chat is called on its timeline.
pub(crate) const CHAT_DOOR: &str = "chat";

pub(crate) struct Chat(pub(crate) Arc<Engine>);

/// A routine that takes a run by hand now.
fn live(routine: &StoredRoutine, now: i64) -> bool {
    routine.origin != BUILTIN
        && !gone(routine, now)
        && matches!(routine.state, RoutineState::Active | RoutineState::Paused)
}

/// The live routine `name` names: its slug, its id, or its name in any case.
pub(crate) fn named(tx: &dyn Tx, name: &str, now: i64) -> Result<Option<StoredRoutine>, Error> {
    let name = name.trim();
    let routines = tx.routines().list()?;
    Ok(routines
        .into_iter()
        .filter(|routine| live(routine, now))
        .find(|routine| routine.slug == name || routine.id == name || routine.name.eq_ignore_ascii_case(name)))
}

/// The item typed in a chat: a link or a text.
pub(crate) fn typed(text: Option<&str>) -> Option<ItemRef> {
    text.map(str::trim).filter(|text| !text.is_empty()).map(item::typed)
}

/// The input of a run asked for in `chat`.
pub(crate) fn input(item: Option<ItemRef>, note: Option<String>, show_only: bool, chat: &str) -> RunInput {
    RunInput {
        item,
        items: None,
        trigger: None,
        options: Default::default(),
        note,
        result: if show_only { ResultMode::ShowOnly } else { ResultMode::Usual },
        at: None,
        surface: None,
        chat: Some(chat.to_owned()),
    }
}

/// Why a start was refused, in one sentence for the model or the user.
pub(crate) fn refused(error: StartError) -> Error {
    match error {
        StartError::Store(error) => error,
        StartError::UnknownRoutine(id) => Error::not_found("routine", id),
        StartError::Invalid(text) => Error::Validation(text),
        other => Error::Conflict(crate::actions::refusal(other).1),
    }
}

impl ChatRoutines for Chat {
    fn list(&self) -> BoxFuture<'_, Result<Vec<ChatRoutine>, Error>> {
        Box::pin(async move {
            let (now, patterns) = (self.0.clock.now_ms(), self.0.patterns.clone());
            self.0
                .store
                .read(move |tx| {
                    let mut listed = Vec::new();
                    for routine in tx.routines().list()?.into_iter().filter(|routine| live(routine, now)) {
                        let Some(row) = summary(tx, &routine, now, &patterns)? else { continue };
                        listed.push(ChatRoutine {
                            slug: row.slug,
                            name: row.name,
                            summary: row.summary,
                            takes: row.takes.takes.label,
                            agents_may_start: routine.agents_may_start && routine.state == RoutineState::Active,
                        });
                    }
                    Ok(listed)
                })
                .await
        })
    }

    fn run<'a>(&'a self, worker_id: &'a str, ask: ChatRunAsk) -> BoxFuture<'a, Result<ChatStart, Error>> {
        Box::pin(async move {
            let (now, name) = (self.0.clock.now_ms(), ask.routine.clone());
            let routine = self.0.store.read(move |tx| named(tx, &name, now)).await?;
            let routine = routine.ok_or_else(|| Error::not_found("routine", &ask.routine))?;
            let (routine_id, routine_name) = (routine.id.clone(), routine.name.clone());
            if !(routine.agents_may_start && routine.state == RoutineState::Active) {
                return Ok(ChatStart::Proposed { routine_id, routine_name });
            }
            let new = NewRun {
                routine_id: routine.id.clone(),
                version: None,
                // What a chat's agent hands over came from a conversation that may
                // hold outside text: it stays untrusted.
                input: input(typed(ask.item.as_deref()), ask.note, ask.show_only, worker_id),
                items: Vec::new(),
                origin: RunOrigin::Agent { worker_id: worker_id.to_owned() },
                door: Some(CHAT_DOOR.into()),
                confirm_repeat: false,
                client_request_id: None,
            };
            let made = engine::start_runs(&self.0, new).await.map_err(refused)?;
            let run_id = made.into_iter().next().map(|run| run.id).unwrap_or_default();
            Ok(ChatStart::Started { run_id, routine_id, routine_name })
        })
    }
}
