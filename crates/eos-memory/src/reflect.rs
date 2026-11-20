//! Reflection: pending moments become notes, oldest first by priority (said,
//! outcome, did, weak). A moment is reflected by the small model when the
//! host lets it ask one ([`ModelGate`]) and the chat ran on Anthropic's
//! models; otherwise the rules keep what they can (the user's own words, a
//! hard-won command) and nothing else is learned. A stated rule never waits
//! for a model. Every text passes `clean` before it is stored, and a lesson
//! that only repeats outside text is kept as a short-lived guess.

use std::collections::HashSet;
use std::sync::Arc;

use eos_core::agent::{OneShot, OneShotRequest};
use eos_core::os::TimeZone;
use eos_core::store::{DailyCall, Store, StoredMoment};
use eos_core::{BoxFuture, Clock, Error, Ids};
use eos_domain::EventRecord;
use eos_domain::experience::Trust;
use eos_domain::experience::clean::{clean, clean_about_user};
use eos_domain::experience::cues::Cue;
use eos_domain::experience::merge::{MergePlan, apply};
use eos_domain::experience::moments::Signal;
use eos_domain::experience::reflect::{Answer, Draft, answer_schema, draft_of, template};
use eos_domain::redact::Scrubber;
use eos_domain::time::{iso_from_ms, wall_clock};

use crate::merge::{Place, merge_in};
use crate::recall::{Cues, Recall, Situation};
use crate::settings;
use crate::transcript::render;

/// Reflections a Mac asks the model for in one local day.
pub const REFLECTIONS_PER_DAY: i64 = 60;
/// A moment waits for a model at most this long, then is skipped.
pub const WAIT_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Tries before a moment is given up.
pub const ATTEMPTS: i64 = 3;
/// One reflection's answer, at most.
pub const TIMEOUT_MS: i64 = 30_000;
/// The catalog's small tier.
pub const MODEL: &str = "haiku";
/// Neighbours shown to the model, to label.
const NEIGHBOURS: usize = 5;
/// Moments read in one pass.
const BATCH: i64 = 50;

/// Whether a model may be asked now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Model,
    /// No model at all (only an API key, or a run that is not the installed
    /// app): the rules keep what they can.
    RulesOnly,
    /// Not now (plan usage at the user's line): moments wait.
    Wait,
}

pub trait ModelGate: Send + Sync {
    fn gate(&self) -> BoxFuture<'_, Gate>;
}

/// What a moment happened in.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MomentContext {
    /// The conversation up to the moment's last row, oldest first.
    pub rows: Vec<EventRecord>,
    /// The session ran on Anthropic's models: its transcript may go to them.
    pub anthropic: bool,
    /// An untrusted run: every output it read is outside text.
    pub untrusted: bool,
    pub place: Place,
}

/// Where a moment's conversation is read from: the event log, or a
/// Code-view pane's transcript. `None` when it is gone.
pub trait MomentSource: Send + Sync {
    fn context<'a>(&'a self, moment: &'a StoredMoment) -> BoxFuture<'a, Result<Option<MomentContext>, Error>>;
}

/// The prompt of one reflection, from the library.
pub trait ReflectPrompt: Send + Sync {
    /// `(system, request)`.
    fn render(&self, signal: &str, transcript: &str, neighbours: &str) -> Result<(String, String), Error>;
}

/// What one pass did, by count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pass {
    pub learned: usize,
    pub merged: usize,
    pub skipped: usize,
    pub failed: usize,
    /// Moments left waiting for a model.
    pub waiting: bool,
}

pub struct ReflectParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub zone: Arc<dyn TimeZone>,
    pub one_shot: Arc<dyn OneShot>,
    pub gate: Arc<dyn ModelGate>,
    pub source: Arc<dyn MomentSource>,
    pub prompt: Arc<dyn ReflectPrompt>,
    pub recall: Arc<Recall>,
    pub scrubber: Arc<Scrubber>,
    pub device: String,
}

impl std::fmt::Debug for ReflectParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReflectParts").finish_non_exhaustive()
    }
}

pub struct Reflector(ReflectParts);

impl std::fmt::Debug for Reflector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reflector").finish_non_exhaustive()
    }
}

enum Outcome {
    Learned(bool),
    Skipped,
    Failed,
    Wait,
}

impl Reflector {
    pub fn new(parts: ReflectParts) -> Self {
        Self(parts)
    }

    fn day(&self, now: i64) -> String {
        let local = wall_clock(now, &|at| self.0.zone.offset_minutes_at(at));
        iso_from_ms(local).chars().take(10).collect()
    }

    /// Reflects the pending moments, until none is left or a model is needed
    /// and may not be asked.
    pub async fn pass(&self) -> Result<Pass, Error> {
        let started = self.0.clock.now_ms();
        let mut pass = Pass::default();
        let before = started - WAIT_MS;
        let (on, pending) = self
            .0
            .store
            .write(move |tx, _| {
                tx.mem_moments().skip_older(before, started)?;
                Ok((settings::read_in(tx)?.learning, tx.mem_moments().pending(BATCH)?))
            })
            .await?;
        if !on {
            return Ok(pass);
        }
        let mut gate = None;
        for moment in pending {
            match self.one(&moment, &mut gate).await? {
                Outcome::Learned(true) => pass.learned += 1,
                Outcome::Learned(false) => pass.merged += 1,
                Outcome::Skipped => pass.skipped += 1,
                Outcome::Failed => pass.failed += 1,
                Outcome::Wait => pass.waiting = true,
            }
        }
        let ms = self.0.clock.now_ms() - started;
        if pass != Pass::default() {
            tracing::info!(
                notes_new = pass.learned,
                merged = pass.merged,
                skipped = pass.skipped,
                failed = pass.failed,
                ms,
                "memory: reflected"
            );
        }
        Ok(pass)
    }

    async fn finish(&self, moment: &StoredMoment, state: &'static str) -> Result<(), Error> {
        let (id, now) = (moment.id.clone(), self.0.clock.now_ms());
        self.0.store.write(move |tx, _| tx.mem_moments().finish(&id, state, None, now)).await
    }

    async fn one(&self, moment: &StoredMoment, gate: &mut Option<Gate>) -> Result<Outcome, Error> {
        let Some(signal) = Signal::parse(&moment.signal) else {
            self.finish(moment, "skipped").await?;
            return Ok(Outcome::Skipped);
        };
        let Some(context) = self.0.source.context(moment).await? else {
            // The conversation is gone (a deleted chat, a pane's transcript).
            self.finish(moment, "skipped").await?;
            return Ok(Outcome::Skipped);
        };
        let shown = render(&context.rows, moment.row_from, moment.row_to, context.untrusted, &self.0.scrubber);
        let cues: Vec<Cue> = serde_json::from_str(&moment.cues).unwrap_or_default();
        let by_rules = signal == Signal::StatesRule || !context.anthropic;
        let use_model = !by_rules && {
            if gate.is_none() {
                *gate = Some(self.0.gate.gate().await);
            }
            match gate.unwrap_or(Gate::RulesOnly) {
                Gate::Model => true,
                Gate::RulesOnly => false,
                Gate::Wait => return Ok(Outcome::Wait),
            }
        };
        let (draft, plan) = if use_model {
            match self.ask(moment, signal, &context, &shown, &cues).await? {
                Ok(found) => found,
                Err(outcome) => return Ok(outcome),
            }
        } else {
            match template(signal, shown.user_in_moment.as_deref(), &cues) {
                Some(draft) => (draft, MergePlan::Insert { links: vec![], close: vec![] }),
                None => {
                    self.finish(moment, "skipped").await?;
                    return Ok(Outcome::Skipped);
                }
            }
        };
        let Some(draft) = self.cleaned(draft) else {
            self.finish(moment, "skipped").await?;
            return Ok(Outcome::Skipped);
        };
        let (ids, moment, place, device) =
            (self.0.ids.clone(), moment.clone(), context.place.clone(), self.0.device.clone());
        let now = self.0.clock.now_ms();
        let merged = self
            .0
            .store
            .write(move |tx, out| merge_in(tx, out, ids.as_ref(), &moment, &draft, &plan, &place, &device, now))
            .await?;
        Ok(Outcome::Learned(merged.new))
    }

    /// Asks the model. `Err` carries what became of the moment instead.
    async fn ask(
        &self,
        moment: &StoredMoment,
        signal: Signal,
        context: &MomentContext,
        shown: &crate::transcript::Rendered,
        cues: &[Cue],
    ) -> Result<Result<(Draft, MergePlan), Outcome>, Error> {
        let now = self.0.clock.now_ms();
        let day = self.day(now);
        let counted = self
            .0
            .store
            .write(move |tx, _| {
                let calls = tx.mem_book().daily(&day)?;
                if calls.reflections >= REFLECTIONS_PER_DAY {
                    return Ok(false);
                }
                tx.mem_book().count_call(&day, DailyCall::Reflection).map(|_| true)
            })
            .await?;
        if !counted {
            return Ok(Err(Outcome::Wait));
        }
        let situation = Situation {
            routine: context.place.routine.clone(),
            project: context.place.project.clone(),
            work_kind: None,
        };
        let query = shown.user_in_moment.clone().or_else(|| shown.user.last().cloned());
        let neighbours = self.0.recall.recall(&situation, &Cues { hooks: cues.to_vec(), query }, NEIGHBOURS).await?;
        let listed: Vec<String> = neighbours
            .iter()
            .map(|n| format!("- {} ({}): {}", n.note.note.id, n.note.note.state.as_str(), n.note.note.text))
            .collect();
        let shown_ids: HashSet<String> = neighbours.iter().map(|n| n.note.note.id.clone()).collect();
        let (system, prompt) = self.0.prompt.render(signal.as_str(), &shown.text, &listed.join("\n"))?;
        let request = OneShotRequest::new(prompt)
            .system(system)
            .model(Some(MODEL))
            .schema(answer_schema())
            .timeout_ms(TIMEOUT_MS);
        let answer = match self.0.one_shot.complete(request).await {
            Ok(answer) => answer.structured.and_then(|data| serde_json::from_value::<Answer>(data).ok()),
            Err(e) => {
                tracing::warn!(moment = %moment.id, error = %e, "memory: reflection failed");
                None
            }
        };
        let Some(answer) = answer else {
            let id = moment.id.clone();
            let attempts = self.0.store.write(move |tx, _| tx.mem_moments().add_attempt(&id)).await?;
            if attempts >= ATTEMPTS {
                self.finish(moment, "failed").await?;
                return Ok(Err(Outcome::Failed));
            }
            return Ok(Err(Outcome::Wait));
        };
        let outside: Vec<&str> = shown.outside.iter().map(String::as_str).collect();
        let user: Vec<&str> = shown.user.iter().map(String::as_str).collect();
        match draft_of(&answer, moment.trust, &outside, &user) {
            Ok(draft) => Ok(Ok((draft, apply(&answer.neighbours, &shown_ids)))),
            Err(_) => {
                self.finish(moment, "skipped").await?;
                Ok(Err(Outcome::Skipped))
            }
        }
    }

    /// The draft as it may be stored: its texts cleaned; `None` when the
    /// note's text may not be kept at all.
    fn cleaned(&self, mut draft: Draft) -> Option<Draft> {
        let scrubber = self.0.scrubber.as_ref();
        // A guess may be about the user: no sensitive matter in it.
        draft.text = if draft.trust == Trust::Guess {
            clean_about_user(scrubber, &draft.text).ok()?
        } else {
            clean(scrubber, &draft.text).ok()?
        };
        let part = |text: &str| if text.is_empty() { String::new() } else { clean(scrubber, text).unwrap_or_default() };
        draft.situation = part(&draft.situation);
        draft.wrong = part(&draft.wrong);
        draft.instead = part(&draft.instead);
        draft.evidence = part(&draft.evidence);
        Some(draft)
    }
}
