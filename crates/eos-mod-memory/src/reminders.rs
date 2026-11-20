//! Notes in every chat: a pack at the first turn of each epoch of a
//! conversation (its start, and after each compaction), and reminders when
//! a message, a tool call or an error matches what was learned. A note is
//! never delivered twice in an epoch. Nothing goes to a session whose
//! backend kind the user withholds the profile from (G21), nor while the
//! Reminders switch is off; a run's lead gets its pack from the routine.
//!
//! Per-session state stays bounded: at most [`CHATS_MAX`] chats, one recall
//! in flight per chat and [`IN_FLIGHT_MAX`] overall; a cue that comes while
//! its chat's recall runs is dropped.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::{ActivityEvent, ActivityEventKind, AgentEvent};
use eos_core::experience::FoundNote;
use eos_core::git::ProjectKeys;
use eos_core::profile::UserProfileReader;
use eos_core::routine::{RunLookup, RunRef};
use eos_core::store::{Store, agent_caller};
use eos_core::{Clock, Ids};
use eos_domain::experience::HookKind;
use eos_domain::experience::budget::REMINDER_NOTES_PER_TURN;
use eos_domain::experience::cues::{self, Cue};
use eos_domain::experience::rank::PACK_THRESHOLD;
use eos_domain::experience::render::{ABOUT_FILE, BEFORE_PUSH, BEFORE_STEP, ERROR_SEEN, ON_REQUEST};
use eos_memory::deliver::{How, Receiver, record, reminder};
use eos_memory::{Cues, Recall, Situation, chat_pack};
use tokio::sync::Semaphore;

/// Chats whose state is kept; past it the oldest-started is dropped.
pub(crate) const CHATS_MAX: usize = 512;
pub(crate) const IN_FLIGHT_MAX: usize = 4;
/// Notes recalled for a pack or a reminder before the cut.
const RECALL_LIMIT: usize = 12;

/// Hands a note to a worker's live session, to go with its next request;
/// `false` when it has none. The app's is the session service.
pub trait NoteSink: Send + Sync {
    fn note(&self, worker_id: &str, text: String) -> bool;
}

/// One conversation's epoch.
struct Chat {
    epoch: i64,
    packed: bool,
    delivered: HashSet<String>,
    /// Reminders given since the user's last message.
    this_turn: usize,
    recalling: bool,
}

/// What `recall_experience` says to an agent the user withholds the
/// profile from, as `search_memory` does.
const WITHHELD: &str = "the user doesn't share their profile with this provider";
/// The most notes one search returns.
const SEARCH_LIMIT_MAX: usize = 10;

enum Located {
    Unknown,
    Withheld,
    Here(Box<Place>),
}

/// Where a session works, as recall needs it.
struct Place {
    situation: Situation,
    root: Option<String>,
    run: Option<RunRef>,
}

pub(crate) struct Reminders {
    pub(crate) recall: Arc<Recall>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn Ids>,
    pub(crate) sink: Arc<dyn NoteSink>,
    pub(crate) project_keys: Arc<dyn ProjectKeys>,
    pub(crate) profile: Arc<dyn UserProfileReader>,
    pub(crate) runs: Option<Arc<dyn RunLookup>>,
    chats: Mutex<HashMap<String, Chat>>,
    in_flight: Semaphore,
}

/// The header and cues of a tool call's moment, when it has cues.
fn tool_moment(activity: &ActivityEvent, root: Option<&str>) -> Option<(&'static str, Vec<Cue>)> {
    let name = activity.tool_name.as_deref()?;
    let input = serde_json::to_value(activity.input.as_ref()?).ok()?;
    let found = cues::from_tool(name, &input, root);
    if found.is_empty() {
        return None;
    }
    let pushing = found.iter().any(|c| c.kind == HookKind::Command && c.key.starts_with("git push"));
    let header = if pushing {
        BEFORE_PUSH
    } else if found.iter().any(|c| c.kind == HookKind::Path) {
        ABOUT_FILE
    } else {
        BEFORE_STEP
    };
    Some((header, found))
}

impl Reminders {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        recall: Arc<Recall>,
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        sink: Arc<dyn NoteSink>,
        project_keys: Arc<dyn ProjectKeys>,
        profile: Arc<dyn UserProfileReader>,
        runs: Option<Arc<dyn RunLookup>>,
    ) -> Self {
        Self {
            recall,
            store,
            clock,
            ids,
            sink,
            project_keys,
            profile,
            runs,
            chats: Mutex::new(HashMap::new()),
            in_flight: Semaphore::new(IN_FLIGHT_MAX),
        }
    }

    fn chats(&self) -> std::sync::MutexGuard<'_, HashMap<String, Chat>> {
        self.chats.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new epoch: the next turn gets a pack, and every note may come again.
    pub(crate) fn reset(&self, worker_id: &str) {
        self.chats().remove(worker_id);
    }

    /// Where the worker works, when notes may reach it: `None` when it is
    /// unknown, the user withholds the profile from its backend kind, or
    /// the Reminders switch is off.
    async fn place(&self, worker_id: &str) -> Option<Place> {
        let on = self.store.read(|tx| Ok(eos_memory::settings::read_in(tx)?.reminders)).await;
        if !on.unwrap_or(false) {
            return None;
        }
        match self.locate(worker_id).await {
            Ok(Located::Here(place)) => Some(*place),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(worker_id, error = %e, "memory: the session's place was not read");
                None
            }
        }
    }

    async fn locate(&self, worker_id: &str) -> Result<Located, eos_core::Error> {
        let worker = worker_id.to_owned();
        let Some(caller) = self.store.read(move |tx| agent_caller(tx.workers(), Some(&worker))).await? else {
            return Ok(Located::Unknown);
        };
        let withheld = caller.kind.as_ref().is_some_and(|kind| self.profile.get().sharing.withhold_from.contains(kind));
        if withheld {
            return Ok(Located::Withheld);
        }
        let project = match caller.project.as_deref() {
            Some(path) => Some(self.project_keys.to_key(path).await),
            None => None,
        };
        let run = match &self.runs {
            Some(runs) => runs.run_of(worker_id).await,
            None => None,
        };
        let situation = Situation { routine: run.as_ref().map(|r| r.routine_id.clone()), project, work_kind: None };
        Ok(Located::Here(Box::new(Place { situation, root: caller.project, run })))
    }

    /// What `recall_experience` answers an agent.
    pub(crate) async fn search(
        &self,
        agent_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<FoundNote>, eos_core::Error> {
        let place = match self.locate(agent_id).await? {
            Located::Here(place) => place,
            Located::Withheld => return Err(eos_core::Error::PermissionDenied(WITHHELD.into())),
            Located::Unknown => return Err(eos_core::Error::PermissionDenied("only an agent can recall".into())),
        };
        let found = cues::from_message(query, place.root.as_deref());
        let wanted = Cues { hooks: found.cues, query: Some(query.to_owned()).filter(|q| !q.trim().is_empty()) };
        let recalled = self.recall.recall(&place.situation, &wanted, limit.clamp(1, SEARCH_LIMIT_MAX)).await?;
        let recalled: Vec<_> = recalled.into_iter().filter(|r| r.score >= PACK_THRESHOLD).collect();
        let note_ids: Vec<String> = recalled.iter().map(|r| r.note.note.id.clone()).collect();
        if !note_ids.is_empty() {
            if let Some(chat) = self.chats().get_mut(agent_id) {
                chat.delivered.extend(note_ids.iter().cloned());
            }
            self.deliver(agent_id, &place, How::Tool, &note_ids).await;
        }
        Ok(recalled
            .into_iter()
            .map(|r| FoundNote {
                id: r.note.note.id,
                text: r.note.note.text,
                scope: r.note.note.scope,
                state: r.note.note.state,
                trust: r.note.note.trust,
            })
            .collect())
    }

    /// The notes that go with a turn: the epoch's pack on its first turn,
    /// else a reminder when the message matches.
    pub(crate) async fn turn_notes(&self, worker_id: &str, message: Option<&str>, start: bool) -> Vec<String> {
        let Some(place) = self.place(worker_id).await else { return Vec::new() };
        let now = self.clock.now_ms();
        let first = {
            let mut chats = self.chats();
            if start {
                chats.remove(worker_id);
            }
            if !chats.contains_key(worker_id) && chats.len() >= CHATS_MAX {
                let oldest = chats.iter().min_by_key(|(_, c)| c.epoch).map(|(id, _)| id.clone());
                oldest.map(|id| chats.remove(&id));
            }
            let chat = chats.entry(worker_id.to_owned()).or_insert_with(|| Chat {
                epoch: now,
                packed: false,
                delivered: HashSet::new(),
                this_turn: 0,
                recalling: false,
            });
            chat.this_turn = 0;
            let first = !chat.packed;
            chat.packed = true;
            first
        };
        // A run's lead has its pack from the routine's brief.
        if first && place.run.is_some() {
            return Vec::new();
        }
        let found = message.map(|m| cues::from_message(m, place.root.as_deref())).unwrap_or_default();
        let wanted = Cues { hooks: found.cues, query: Some(found.query).filter(|q| !q.trim().is_empty()) };
        if !first && wanted.hooks.is_empty() && wanted.query.is_none() {
            return Vec::new();
        }
        let recalled = match self.recall.recall(&place.situation, &wanted, RECALL_LIMIT).await {
            Ok(recalled) => recalled,
            Err(e) => {
                tracing::warn!(worker_id, error = %e, "memory: recall failed");
                return Vec::new();
            }
        };
        let picked = if first { chat_pack(&recalled) } else { self.pick(worker_id, ON_REQUEST, &recalled) };
        let Some(pack) = picked else { return Vec::new() };
        let how = if first { How::Pack } else { How::Reminder };
        self.deliver(worker_id, &place, how, &pack.note_ids).await;
        vec![pack.text]
    }

    /// A reminder for the chat from `recalled`, marked delivered.
    fn pick(&self, worker_id: &str, header: &str, recalled: &[eos_memory::Recalled]) -> Option<eos_memory::Pack> {
        let mut chats = self.chats();
        let chat = chats.get_mut(worker_id)?;
        let room = REMINDER_NOTES_PER_TURN.saturating_sub(chat.this_turn);
        let pack = reminder(header, recalled, &chat.delivered, room)?;
        chat.this_turn += pack.note_ids.len();
        chat.delivered.extend(pack.note_ids.iter().cloned());
        Some(pack)
    }

    async fn deliver(&self, worker_id: &str, place: &Place, how: How, note_ids: &[String]) {
        if how == How::Pack
            && let Some(chat) = self.chats().get_mut(worker_id)
        {
            chat.delivered.extend(note_ids.iter().cloned());
        }
        let epoch = self.chats().get(worker_id).map_or(0, |c| c.epoch);
        let to =
            Receiver { worker_id: worker_id.to_owned(), run_id: place.run.as_ref().map(|r| r.run_id.clone()), epoch };
        if let Err(e) = record(&self.store, self.clock.as_ref(), self.ids.as_ref(), &to, how, note_ids).await {
            tracing::warn!(worker_id, error = %e, "memory: the notes delivered were not recorded");
        }
        tracing::info!(worker_id, notes = note_ids.len(), how = how.as_str(), "memory: notes delivered");
    }

    /// Starts a recall for a tool call's or an error's cues, when the event
    /// has some and the chat has no recall running. A subagent's events
    /// never bring reminders: the note would reach the root agent (G16).
    pub(crate) fn on_event(self: &Arc<Self>, worker_id: &str, event: &AgentEvent) {
        let AgentEvent::Activity(activity) = event else { return };
        if activity.parent_call_id.as_ref().is_some_and(Option::is_some) {
            return;
        }
        let interesting = match activity.kind {
            ActivityEventKind::ToolStarted => activity.tool_name.is_some(),
            ActivityEventKind::ToolFinished => activity.is_error == Some(true),
            ActivityEventKind::Alive => false,
        };
        if !interesting {
            return;
        }
        {
            let mut chats = self.chats();
            let Some(chat) = chats.get_mut(worker_id) else { return };
            if chat.recalling {
                return;
            }
            chat.recalling = true;
        }
        let this = self.clone();
        let worker_id = worker_id.to_owned();
        let activity = activity.clone();
        tokio::spawn(async move {
            if let Ok(_permit) = this.in_flight.try_acquire() {
                this.remind(&worker_id, &activity).await;
            }
            if let Some(chat) = this.chats().get_mut(&worker_id) {
                chat.recalling = false;
            }
        });
    }

    async fn remind(&self, worker_id: &str, activity: &ActivityEvent) {
        let Some(place) = self.place(worker_id).await else { return };
        let moment = match activity.kind {
            ActivityEventKind::ToolFinished => {
                activity.result.as_deref().and_then(cues::from_error).map(|cue| (ERROR_SEEN, vec![cue]))
            }
            _ => tool_moment(activity, place.root.as_deref()),
        };
        let Some((header, hooks)) = moment else { return };
        let recalled = match self.recall.recall(&place.situation, &Cues { hooks, query: None }, RECALL_LIMIT).await {
            Ok(recalled) => recalled,
            Err(e) => {
                tracing::warn!(worker_id, error = %e, "memory: recall failed");
                return;
            }
        };
        let Some(pack) = self.pick(worker_id, header, &recalled) else { return };
        if self.sink.note(worker_id, pack.text) {
            self.deliver(worker_id, &place, How::Reminder, &pack.note_ids).await;
        }
    }
}
